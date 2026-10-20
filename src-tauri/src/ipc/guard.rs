//! `ipc/` の検査（テストのみ）。
//!
//! `ipc/` はカバレッジの対象から外している。その除外が正当であり続けるために、次を検査する。
//! 1. 置いてよいのは `use` / `mod` と、`#[tauri::command]` の関数だけ。ロジックを隠せる別の関数・型・実装は置けない。
//! 2. コマンドの本文は、文の数が少なく、分岐・繰り返し（`if` / `match` / `for` / `while` / `loop` / `&&` / `||` /
//!    `let ... else`）を含まない。含まれていたら、`commands/` 側のテストできる関数へ切り出す。
//! 3. コマンドが `lib.rs` の `generate_handler!` の登録と過不足なく一致する（除外している以上、登録漏れはここで検出する）。
//! 4. ディレクトリのファイルがすべて `mod.rs` に宣言されている。
//! 5. 除外の設定（CI の `cargo llvm-cov` と `codecov.yml`）が、このディレクトリを指している。
//!
//! `commands/updater_tauri.rs`（`AppHandle` と updater プラグインへの接続部）も、同じ理由で除外している。下の `glue_violations` が、
//! `use` と関数だけ・本文の文の数・分岐と繰り返し・ファイルの行数を検査する。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use syn::visit::Visit;
use syn::{BinOp, Expr, ExprBinary, Item, ItemFn, Stmt};

/// コマンドの本文に置いてよい文の数。「状態を取り出す → 関数を呼ぶ」程度に収める。
const MAX_STATEMENTS: usize = 4;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn is_tauri_command(function: &ItemFn) -> bool {
    function.attrs.iter().any(|attr| {
        let segments: Vec<String> = attr
            .path()
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect();
        segments == ["tauri", "command"]
    })
}

/// 分岐・繰り返しを見つける。
#[derive(Default)]
struct LogicFinder {
    found: Vec<&'static str>,
}

impl<'ast> Visit<'ast> for LogicFinder {
    fn visit_expr(&mut self, expr: &'ast Expr) {
        match expr {
            Expr::If(_) => self.found.push("if"),
            Expr::Match(_) => self.found.push("match"),
            Expr::ForLoop(_) => self.found.push("for"),
            Expr::While(_) => self.found.push("while"),
            Expr::Loop(_) => self.found.push("loop"),
            Expr::Binary(ExprBinary {
                op: BinOp::And(_) | BinOp::Or(_),
                ..
            }) => self.found.push("&& / ||"),
            _ => {}
        }
        syn::visit::visit_expr(self, expr);
    }

    fn visit_stmt(&mut self, stmt: &'ast Stmt) {
        match stmt {
            Stmt::Local(local)
                if local
                    .init
                    .as_ref()
                    .is_some_and(|init| init.diverge.is_some()) =>
            {
                self.found.push("let ... else");
            }
            Stmt::Item(_) => self.found.push("入れ子の item"),
            _ => {}
        }
        syn::visit::visit_stmt(self, stmt);
    }
}

/// `ipc/` の 1 ファイルを検査し、違反を返す。`is_mod_rs` のときは `mod` の宣言も置いてよい。
fn violations_in(file_name: &str, source: &str, is_mod_rs: bool) -> Vec<String> {
    let file = match syn::parse_file(source) {
        Ok(file) => file,
        Err(e) => return vec![format!("{file_name}: 解析できません: {e}")],
    };

    let mut violations = Vec::new();
    for item in &file.items {
        match item {
            Item::Use(_) => {}
            Item::Mod(module) if is_mod_rs => {
                // `#[cfg(test)] mod guard;` 以外のインラインのモジュールは、ロジックを置ける場所になる。
                if module.content.is_some() {
                    violations.push(format!("{file_name}: インラインの mod は置けません"));
                }
            }
            Item::Fn(function) if is_tauri_command(function) => {
                let name = &function.sig.ident;
                let statements = function.block.stmts.len();
                if statements > MAX_STATEMENTS {
                    violations.push(format!(
                        "{file_name}: {name} の本文が長すぎます（{statements} 文 > {MAX_STATEMENTS} 文）。ロジックは commands/ へ"
                    ));
                }
                let mut finder = LogicFinder::default();
                finder.visit_block(&function.block);
                for kind in finder.found {
                    violations.push(format!(
                        "{file_name}: {name} に {kind} があります。ロジックは commands/ へ"
                    ));
                }
            }
            Item::Fn(function) => violations.push(format!(
                "{file_name}: #[tauri::command] ではない関数 {} は置けません",
                function.sig.ident
            )),
            _ => violations.push(format!(
                "{file_name}: use / mod / #[tauri::command] の関数以外は置けません"
            )),
        }
    }
    violations
}

/// `ipc/` の `#[tauri::command]` の関数名。
fn command_names(source: &str) -> Vec<String> {
    syn::parse_file(source)
        .map(|file| {
            file.items
                .iter()
                .filter_map(|item| match item {
                    Item::Fn(function) if is_tauri_command(function) => {
                        Some(function.sig.ident.to_string())
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// カバレッジの対象外にしている、`ipc/` 以外のファイル（外部への接続部だけ）。`ipc/` と同じく、
/// ロジックを置ける場所にならないよう、分岐・繰り返しと、関数以外の定義を検査する。
const EXCLUDED_GLUE: &str = "updater_tauri.rs";

/// 接続部のファイルの行数の上限。除外する範囲が、気づかないうちに広がらないようにする。
const MAX_GLUE_LINES: usize = 90;

/// `commands/` の接続部のファイルを検査し、違反を返す。置いてよいのは `use` と関数だけで、
/// 関数の本文に分岐・繰り返しは置けない（テストする流れは、呼ぶ側の `commands/` の関数に置く）。
fn glue_violations(file_name: &str, source: &str) -> Vec<String> {
    let file = match syn::parse_file(source) {
        Ok(file) => file,
        Err(e) => return vec![format!("{file_name}: 解析できません: {e}")],
    };

    let mut violations = Vec::new();
    for item in &file.items {
        match item {
            Item::Use(_) => {}
            Item::Fn(function) => {
                let name = &function.sig.ident;
                let statements = function.block.stmts.len();
                if statements > MAX_STATEMENTS {
                    violations.push(format!(
                        "{file_name}: {name} の本文が長すぎます（{statements} 文 > {MAX_STATEMENTS} 文）。流れは、テストできる関数へ"
                    ));
                }
                let mut finder = LogicFinder::default();
                finder.visit_block(&function.block);
                for kind in finder.found {
                    violations.push(format!(
                        "{file_name}: {name} に {kind} があります。流れは、テストできる関数へ"
                    ));
                }
            }
            _ => violations.push(format!("{file_name}: use と関数以外は置けません")),
        }
    }
    if source.lines().count() > MAX_GLUE_LINES {
        violations.push(format!(
            "{file_name}: ファイルが長すぎます（{} 行 > {MAX_GLUE_LINES} 行）。除外する範囲を広げず、流れは、テストできる関数へ",
            source.lines().count()
        ));
    }
    violations
}

/// `generate_handler![ ... ]` に並んでいるコマンド名（`モジュール::名前` の名前）。
fn registered_names(lib_source: &str) -> Vec<String> {
    let start = lib_source
        .find("generate_handler![")
        .expect("lib.rs に generate_handler! がありません");
    let body = &lib_source[start + "generate_handler![".len()..];
    let body = &body[..body.find(']').expect("generate_handler! が閉じていません")];
    body.lines()
        .map(|line| line.split("//").next().unwrap_or("").trim())
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.rsplit("::").next().unwrap_or(entry).to_string())
        .collect()
}

fn ipc_files() -> Vec<(String, String)> {
    let dir = manifest_dir().join("src").join("ipc");
    let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .expect("ipc/ を読めません")
        .map(|entry| entry.expect("ipc/ のエントリを読めません").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let source = std::fs::read_to_string(&path).expect("ipc/ のファイルを読めません");
            (name, source)
        })
        // このファイル（検査そのもの）はテストのコードなので、対象にしない。
        .filter(|(name, _)| name != "guard.rs")
        .collect();
    files.sort();
    files
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{} を読めません: {e}", path.display()))
}

// ── 検査の自己テスト ──────────────────────────────────────────────────────────

#[test]
fn a_thin_command_passes() {
    let source = r#"
        use crate::x::y;
        #[tauri::command(async)]
        pub fn thin(a: String) -> Result<(), String> {
            let config = load()?;
            y(&config, &a)
        }
        #[tauri::command]
        pub fn with_closure() -> Result<u8, String> {
            modify(|config| Ok(change(config)))
        }
    "#;

    assert_eq!(violations_in("x.rs", source, false), Vec::<String>::new());
}

#[test]
fn logic_in_a_command_is_reported() {
    let cases = [
        ("if", "if flag { a() } else { b() }"),
        ("match", "match flag { true => a(), false => b() }"),
        ("for", "for _ in 0..2 { a(); } a()"),
        ("while", "while flag { a(); } a()"),
        ("loop", "loop { break; } a()"),
        ("&& / ||", "let ok = flag && other; a(ok)"),
        ("let ... else", "let Some(x) = opt else { return; }; a(x)"),
        ("入れ子の item", "fn helper() {} a()"),
    ];

    for (kind, body) in cases {
        let source = format!(
            "#[tauri::command] pub fn bad(flag: bool, other: bool, opt: Option<u8>) {{ {body} }}"
        );

        let violations = violations_in("x.rs", &source, false);

        assert!(
            violations.iter().any(|v| v.contains(kind)),
            "{kind} を検出できません: {violations:?}"
        );
    }
}

#[test]
fn logic_inside_a_closure_is_reported() {
    let source =
        "#[tauri::command] pub fn bad(flag: bool) { run(|| if flag { a() } else { b() }) }";

    assert!(violations_in("x.rs", source, false)
        .iter()
        .any(|v| v.contains("if")));
}

#[test]
fn a_long_command_body_is_reported() {
    let source = "#[tauri::command] pub fn long() { a(); b(); c(); d(); e() }";

    let violations = violations_in("x.rs", source, false);

    assert!(
        violations.iter().any(|v| v.contains("本文が長すぎます")),
        "{violations:?}"
    );
}

#[test]
fn items_that_could_hide_logic_are_reported() {
    let cases = [
        ("関数", "pub fn helper() {}"),
        ("型", "pub struct S;"),
        ("実装", "impl S { pub fn f() {} }"),
        ("定数", "pub const X: u8 = 1;"),
        ("テストモジュール", "#[cfg(test)] mod tests {}"),
    ];

    for (kind, source) in cases {
        let violations = violations_in("x.rs", source, false);

        assert!(!violations.is_empty(), "{kind} を検出できません");
    }
}

#[test]
fn mod_rs_may_declare_modules_but_not_inline_ones() {
    assert!(violations_in("mod.rs", "pub mod a; #[cfg(test)] mod guard;", true).is_empty());
    assert!(!violations_in("mod.rs", "pub mod a { pub fn f() {} }", true).is_empty());
    // mod.rs 以外では mod を置けない
    assert!(!violations_in("x.rs", "pub mod a;", false).is_empty());
}

#[test]
fn registered_names_reads_the_handler_list() {
    let lib = "tauri::generate_handler![\n  // Config\n  settings::get_config,\n  repo::fetch_all, // 1 件\n  dsx::dsx_check,\n]";

    assert_eq!(
        registered_names(lib),
        ["get_config", "fetch_all", "dsx_check"]
    );
}

// ── 実際の ipc/ の検査 ────────────────────────────────────────────────────────

#[test]
fn ipc_has_only_thin_command_wrappers() {
    let files = ipc_files();
    assert!(files.len() >= 2, "ipc/ のファイルを読めていません");

    let violations: Vec<String> = files
        .iter()
        .flat_map(|(name, source)| violations_in(name, source, name == "mod.rs"))
        .collect();

    assert!(
        violations.is_empty(),
        "ipc/ にロジックがあります:\n{}",
        violations.join("\n")
    );
}

#[test]
fn every_ipc_file_is_declared_in_mod_rs() {
    let files = ipc_files();
    let mod_source = &files
        .iter()
        .find(|(name, _)| name == "mod.rs")
        .expect("mod.rs")
        .1;

    for (name, _) in files.iter().filter(|(name, _)| name != "mod.rs") {
        let module = name.trim_end_matches(".rs");
        assert!(
            mod_source.contains(&format!("pub mod {module};")),
            "{name} が mod.rs で宣言されていません"
        );
    }
}

#[test]
fn ipc_commands_match_the_registered_handlers() {
    let defined: BTreeSet<String> = ipc_files()
        .iter()
        .flat_map(|(_, source)| command_names(source))
        .collect();
    let registered_list = registered_names(&read(&manifest_dir().join("src").join("lib.rs")));
    let registered: BTreeSet<String> = registered_list.iter().cloned().collect();

    assert_eq!(
        registered_list.len(),
        registered.len(),
        "generate_handler! に重複があります"
    );
    assert!(defined.len() >= 20, "ipc/ のコマンドを読めていません");
    let unregistered: Vec<_> = defined.difference(&registered).collect();
    let undefined: Vec<_> = registered.difference(&defined).collect();
    assert!(
        unregistered.is_empty(),
        "lib.rs に登録されていないコマンド: {unregistered:?}"
    );
    assert!(
        undefined.is_empty(),
        "ipc/ に無いコマンドが登録されています: {undefined:?}"
    );
}

#[test]
fn coverage_exclusions_point_at_the_ipc_directory() {
    let root = manifest_dir().join("..");
    let ci = read(&root.join(".github").join("workflows").join("ci.yml"));
    let codecov = read(&root.join("codecov.yml"));

    assert!(
        ci.contains("--ignore-filename-regex") && ci.contains("ipc"),
        "CI の cargo llvm-cov が ipc/ を除外していません"
    );
    assert!(
        codecov.contains("src-tauri/src/ipc/"),
        "codecov.yml の ignore が ipc/ を除外していません"
    );
}

#[test]
fn coverage_exclusions_point_at_the_glue_file() {
    let root = manifest_dir().join("..");
    let ci = read(&root.join(".github").join("workflows").join("ci.yml"));
    let codecov = read(&root.join("codecov.yml"));
    let pattern = EXCLUDED_GLUE.replace('.', "\\.");

    assert!(
        ci.contains(&pattern),
        "CI の cargo llvm-cov が {EXCLUDED_GLUE} を除外していません"
    );
    assert!(
        codecov.contains(&format!("src-tauri/src/commands/{EXCLUDED_GLUE}")),
        "codecov.yml の ignore が {EXCLUDED_GLUE} を除外していません"
    );
}

#[test]
fn the_excluded_glue_file_has_no_logic() {
    let path = manifest_dir()
        .join("src")
        .join("commands")
        .join(EXCLUDED_GLUE);

    assert_eq!(
        glue_violations(EXCLUDED_GLUE, &read(&path)),
        Vec::<String>::new()
    );
}

#[test]
fn logic_in_the_glue_file_is_reported() {
    let cases = [
        ("if", "async fn f() { if flag { a() } else { b() } }"),
        (
            "match",
            "fn f() { match flag { true => a(), false => b() } }",
        ),
        ("&& / ||", "fn f() { let ok = flag && other; a(ok) }"),
        ("use と関数以外", "#[cfg(test)] mod tests {}"),
        ("use と関数以外", "struct Holder;"),
        ("長すぎます（5 文", "fn f() { a(); b(); c(); d(); e() }"),
    ];

    for (kind, source) in cases {
        let violations = glue_violations("x.rs", source);
        assert!(
            violations.iter().any(|v| v.contains(kind)),
            "{kind}: {violations:?}"
        );
    }

    let long_file = "use a::b;\n".repeat(MAX_GLUE_LINES + 1);
    assert!(glue_violations("x.rs", &long_file)
        .iter()
        .any(|v| v.contains("ファイルが長すぎます")));
}

#[test]
fn a_thin_glue_file_passes() {
    let source = r#"
        use crate::x::y;
        async fn f(app: &AppHandle) -> Result<u8, String> {
            y(app).await.map_err(|e| format!("失敗: {e}"))
        }
    "#;

    assert_eq!(glue_violations("x.rs", source), Vec::<String>::new());
}
