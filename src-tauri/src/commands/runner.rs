//! 外部コマンドの実行基盤。
//!
//! 子プロセスの stdout / stderr を、行（または `\r` で上書きされる進捗行）ごとに
//! `process_*` イベントとして UI へ流し、キャンセル時はプロセスツリーごと止める。
//!
//! - 同時に実行できるのは 1 件だけ。`dsx sys update` と `dsx repo update` のように、
//!   同じツール・リポジトリを触るコマンドの競合を避ける。
//! - 実行が終わった時点で、そのコマンドが残した子孫プロセスも止める
//!   （Arbor が実行したコマンドのプロセスツリーは、実行後に残さない）。
//! - 起動とイベント送信は trait で抽象化し、テストではフェイクに差し替える。

use serde::Serialize;
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// ─── イベント ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStarted {
    pub run_id: u64,
    pub label: String,
    pub argv: Vec<String>,
    /// Unix epoch ミリ秒。
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    pub run_id: u64,
    pub stream: Stream,
    pub text: String,
    /// true のとき、直前の「進捗行」（`\r` で終わった行）を置き換える。
    pub overwrite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessFinished {
    pub run_id: u64,
    /// シグナル終了などで終了コードが無い場合は None。
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub cancelled: bool,
}

/// UI へイベントを送る先。
pub trait EventSink: Send + Sync {
    fn started(&self, event: &ProcessStarted);
    fn output(&self, event: &ProcessOutput);
    fn finished(&self, event: &ProcessFinished);
}

/// Tauri のイベントとして WebView へ送る。
pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn emit<T: Serialize + Clone>(&self, name: &str, payload: &T) {
        if let Err(e) = self.app.emit(name, payload) {
            eprintln!("Warning: failed to emit {name}: {e}");
        }
    }
}

impl EventSink for TauriSink {
    fn started(&self, event: &ProcessStarted) {
        self.emit("process_started", event);
    }

    fn output(&self, event: &ProcessOutput) {
        self.emit("process_output", event);
    }

    fn finished(&self, event: &ProcessFinished) {
        self.emit("process_finished", event);
    }
}

// ─── 行分割 ───────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub struct Piece {
    pub text: String,
    pub overwrite: bool,
}

/// バイト列を「行」に分ける。`\n`・`\r\n` で確定する行と、`\r` だけで終わる進捗行を区別する。
///
/// 進捗行は端末と同じく、次の出力で上書きされる行として扱う。
/// 不正な UTF-8（winget などが出す CP932 を含む）は置換文字にして、読み取りを止めない。
#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
    /// 直前のバイトが `\r` で、次のバイトが `\n` かどうかを見てから行の種類を決める。
    pending_cr: bool,
    /// 直前に出した行が進捗行（次の出力で置き換わる）かどうか。
    in_progress: bool,
}

impl LineSplitter {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Piece> {
        let mut out = Vec::new();
        for &byte in chunk {
            if self.pending_cr {
                self.pending_cr = false;
                if byte == b'\n' {
                    out.push(self.take(false));
                    continue;
                }
                out.push(self.take(true));
            }
            match byte {
                b'\n' => out.push(self.take(false)),
                b'\r' => self.pending_cr = true,
                _ => self.buf.push(byte),
            }
        }
        out
    }

    /// 入力の終端。改行で終わっていない最後の行を確定させる。
    pub fn finish(&mut self) -> Option<Piece> {
        self.pending_cr = false;
        if self.buf.is_empty() {
            return None;
        }
        Some(self.take(false))
    }

    fn take(&mut self, progress: bool) -> Piece {
        let text = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
        let piece = Piece {
            text,
            overwrite: self.in_progress,
        };
        self.in_progress = progress;
        piece
    }
}

// ─── 起動 ─────────────────────────────────────────────────────────────────────

pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

pub struct Launched {
    pub stdout: Box<dyn Read + Send>,
    pub stderr: Box<dyn Read + Send>,
    /// 終了まで待ち、終了コードを返す。
    pub wait: Box<dyn FnOnce() -> io::Result<Option<i32>> + Send>,
    /// プロセスツリーを強制終了する。何度呼んでもよい。
    pub terminate: Arc<dyn Fn() + Send + Sync>,
}

pub trait Launcher: Send + Sync {
    fn launch(&self, spec: &LaunchSpec) -> io::Result<Launched>;
}

/// OS のプロセスとして起動する。
pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn launch(&self, spec: &LaunchSpec) -> io::Result<Launched> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            // 対話入力を待つコマンド（bw unlock など）が止まらず、即座に失敗するようにする。
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        tree::prepare(&mut command);

        let mut child = command.spawn()?;
        let tree = match tree::Tree::attach(&child) {
            Ok(tree) => Arc::new(tree),
            Err(e) => {
                // ツリーを管理できないまま走らせない。
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("failed to capture child output"));
        };

        let terminate_tree = Arc::clone(&tree);
        Ok(Launched {
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
            wait: Box::new(move || {
                let status = child.wait()?;
                // 終了コードを返した後でも、孫プロセスが出力パイプを握り続けると読み取りが終わらない。
                tree.terminate();
                Ok(status.code())
            }),
            terminate: Arc::new(move || terminate_tree.terminate()),
        })
    }
}

#[cfg(windows)]
mod tree {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// リリースビルド（windows_subsystem = "windows"）で、コンソールアプリの窓が出ないようにする。
    pub fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    /// 子プロセスとその子孫をまとめる Job Object。
    /// ハンドルを閉じる（Arbor の終了・クラッシュを含む）と、残っているプロセスも終了する。
    pub struct Tree {
        job: HANDLE,
    }

    // SAFETY: Job Object のハンドルはプロセス全体で有効なカーネルハンドルで、
    // どのスレッドから操作してもよい。
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}

    impl Tree {
        /// 起動直後の子を Job に入れる。入れるまでの短い間に子が作ったプロセスは Job に入らない。
        pub fn attach(child: &Child) -> io::Result<Self> {
            // SAFETY: 引数はこのブロック内で有効な値で、戻り値は検査する。
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // 以降の失敗でもハンドルを確実に閉じるため、先に所有させる。
                let tree = Tree { job };

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0 {
                    return Err(io::Error::last_os_error());
                }
                if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(tree)
            }
        }

        pub fn terminate(&self) {
            // SAFETY: self.job は Drop まで有効。空の Job に対しても呼べる。
            unsafe {
                TerminateJobObject(self.job, 1);
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            // SAFETY: self.job はこの構造体だけが所有し、ここで一度だけ閉じる。
            unsafe {
                CloseHandle(self.job);
            }
        }
    }
}

#[cfg(unix)]
mod tree {
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    /// 子を新しいプロセスグループのリーダーにして、グループごと止められるようにする。
    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }

    pub struct Tree {
        pgid: libc::pid_t,
    }

    impl Tree {
        pub fn attach(child: &Child) -> io::Result<Self> {
            let pgid = libc::pid_t::try_from(child.id())
                .map_err(|_| io::Error::other("child pid does not fit in pid_t"))?;
            Ok(Self { pgid })
        }

        pub fn terminate(&self) {
            // SAFETY: 負の値は「そのプロセスグループ全体」を指す。グループが空なら ESRCH で失敗するだけ。
            unsafe {
                libc::kill(-self.pgid, libc::SIGKILL);
            }
        }
    }
}

// ─── 実行 ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct RunOutcome {
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub stdout: String,
    pub stderr: String,
}

struct Active {
    run_id: u64,
    terminate: Arc<dyn Fn() + Send + Sync>,
    cancelled: Arc<AtomicBool>,
}

pub struct Runner {
    launcher: Arc<dyn Launcher>,
    sink: Arc<dyn EventSink>,
    next_id: AtomicU64,
    active: Mutex<Option<Active>>,
}

impl Runner {
    pub fn new(launcher: Arc<dyn Launcher>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            launcher,
            sink,
            next_id: AtomicU64::new(1),
            active: Mutex::new(None),
        }
    }

    fn lock_active(&self) -> std::sync::MutexGuard<'_, Option<Active>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// コマンドを実行し、終了まで待つ。実行中は `process_*` イベントを送り続ける。
    /// すでに別のコマンドが実行中のときは、起動せずにエラーを返す。
    pub fn run(&self, label: &str, spec: LaunchSpec) -> Result<RunOutcome, String> {
        let run_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.lock_active();
            if let Some(running) = active.as_ref() {
                return Err(format!(
                    "別のコマンドを実行中です（run {}）。完了またはキャンセルしてから再実行してください",
                    running.run_id
                ));
            }
            // 起動の前に枠を確保する。起動中の cancel は、起動後に terminate を呼んで反映する。
            *active = Some(Active {
                run_id,
                terminate: Arc::new(|| {}),
                cancelled: Arc::clone(&cancelled),
            });
        }

        let result = self.run_reserved(run_id, label, &spec, &cancelled);
        *self.lock_active() = None;
        result
    }

    fn run_reserved(
        &self,
        run_id: u64,
        label: &str,
        spec: &LaunchSpec,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<RunOutcome, String> {
        let started = Instant::now();
        let launched = self
            .launcher
            .launch(spec)
            .map_err(|e| format!("Failed to spawn {}: {e}", spec.program))?;

        if let Some(active) = self.lock_active().as_mut() {
            active.terminate = Arc::clone(&launched.terminate);
        }
        if cancelled.load(Ordering::SeqCst) {
            (launched.terminate)();
        }

        let mut argv = vec![spec.program.clone()];
        argv.extend(spec.args.iter().cloned());
        self.sink.started(&ProcessStarted {
            run_id,
            label: label.to_string(),
            argv,
            started_at: unix_millis(),
        });

        let Launched {
            stdout,
            stderr,
            wait,
            terminate: _,
        } = launched;
        let stdout_reader = spawn_reader(Arc::clone(&self.sink), run_id, Stream::Stdout, stdout);
        let stderr_reader = spawn_reader(Arc::clone(&self.sink), run_id, Stream::Stderr, stderr);

        let exit = wait();
        let stdout_text = stdout_reader.join().unwrap_or_default();
        let stderr_text = stderr_reader.join().unwrap_or_default();

        let exit_code = exit.as_ref().ok().copied().flatten();
        let was_cancelled = cancelled.load(Ordering::SeqCst);
        self.sink.finished(&ProcessFinished {
            run_id,
            exit_code,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            cancelled: was_cancelled,
        });

        exit.map_err(|e| format!("Failed to wait for {}: {e}", spec.program))?;
        Ok(RunOutcome {
            exit_code,
            cancelled: was_cancelled,
            stdout: stdout_text,
            stderr: stderr_text,
        })
    }

    /// 実行中のコマンドをプロセスツリーごと強制終了する。
    pub fn cancel(&self, run_id: u64) -> Result<(), String> {
        let (terminate, cancelled) = match self.lock_active().as_ref() {
            Some(active) if active.run_id == run_id => {
                (Arc::clone(&active.terminate), Arc::clone(&active.cancelled))
            }
            _ => return Err(format!("実行中のコマンドが見つかりません（run {run_id}）")),
        };
        cancelled.store(true, Ordering::SeqCst);
        terminate();
        Ok(())
    }
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// 1 本のストリームを読み切り、行ごとにイベントを送る。確定した出力を `\n` 区切りで返す。
fn spawn_reader(
    sink: Arc<dyn EventSink>,
    run_id: u64,
    stream: Stream,
    mut reader: Box<dyn Read + Send>,
) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut splitter = LineSplitter::default();
        let mut collected: Vec<String> = Vec::new();
        let mut emit = |piece: Piece| {
            sink.output(&ProcessOutput {
                run_id,
                stream,
                text: piece.text.clone(),
                overwrite: piece.overwrite,
            });
            if piece.overwrite {
                collected.pop();
            }
            collected.push(piece.text);
        };

        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => splitter.feed(&buf[..n]).into_iter().for_each(&mut emit),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => {
                    emit(Piece {
                        text: format!("[arbor] 出力の読み取りに失敗しました: {e}"),
                        overwrite: false,
                    });
                    break;
                }
            }
        }
        if let Some(piece) = splitter.finish() {
            emit(piece);
        }
        collected.join("\n")
    })
}

// ─── Tauri state / command ────────────────────────────────────────────────────

pub struct RunnerState(Arc<Runner>);

impl RunnerState {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self(Arc::new(Runner::new(Arc::new(SystemLauncher), sink)))
    }

    pub fn runner(&self) -> Arc<Runner> {
        Arc::clone(&self.0)
    }
}

/// 実行中のコマンドをキャンセルする。`run_id` は `process_started` イベントで通知される。
#[tauri::command]
pub fn cancel_run(state: tauri::State<'_, RunnerState>, run_id: u64) -> Result<(), String> {
    state.0.cancel(run_id)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc;
    use std::time::Duration;

    // ── LineSplitter ──────────────────────────────────────────────────────────

    fn piece(text: &str, overwrite: bool) -> Piece {
        Piece {
            text: text.to_string(),
            overwrite,
        }
    }

    fn split(chunks: &[&[u8]]) -> Vec<Piece> {
        let mut splitter = LineSplitter::default();
        let mut out: Vec<Piece> = chunks.iter().flat_map(|c| splitter.feed(c)).collect();
        out.extend(splitter.finish());
        out
    }

    type SplitCase<'a> = (&'a str, Vec<&'a [u8]>, Vec<Piece>);

    #[test]
    fn line_splitter_cases() {
        let cases: Vec<SplitCase> = vec![
            (
                "LF 区切り",
                vec![b"a\nb\n"],
                vec![piece("a", false), piece("b", false)],
            ),
            (
                "CRLF は 1 つの改行",
                vec![b"a\r\nb\r\n"],
                vec![piece("a", false), piece("b", false)],
            ),
            (
                "CRLF が chunk をまたぐ",
                vec![b"a\r", b"\nb\n"],
                vec![piece("a", false), piece("b", false)],
            ),
            (
                "空行も 1 行として出す",
                vec![b"a\n\nb\n"],
                vec![piece("a", false), piece("", false), piece("b", false)],
            ),
            (
                "末尾に改行が無い最後の行",
                vec![b"a\nlast"],
                vec![piece("a", false), piece("last", false)],
            ),
            (
                "進捗行は次の出力で上書きされ、LF で確定する",
                vec![b"10%\r20%\r30%\n"],
                vec![piece("10%", false), piece("20%", true), piece("30%", true)],
            ),
            (
                "進捗行の後の通常行は上書きにならない",
                vec![b"10%\r20%\ndone\n"],
                vec![
                    piece("10%", false),
                    piece("20%", true),
                    piece("done", false),
                ],
            ),
            (
                "CR が chunk の末尾で切れても同じ結果",
                vec![b"10%\r", b"20%\n"],
                vec![piece("10%", false), piece("20%", true)],
            ),
            (
                "UTF-8 が chunk をまたぐ",
                vec![&[0xE3, 0x81][..], &[0x82, b'\n'][..]],
                vec![piece("あ", false)],
            ),
            (
                "不正な UTF-8 は置換文字にして続行する",
                vec![&[b'a', 0x82, 0xA0, b'\n', b'b', b'\n'][..]],
                vec![piece("a\u{FFFD}\u{FFFD}", false), piece("b", false)],
            ),
            ("入力なし", vec![], vec![]),
            ("末尾の CR のみ", vec![b"a\n\r"], vec![piece("a", false)]),
        ];

        for (name, chunks, expected) in cases {
            assert_eq!(split(&chunks), expected, "{name}");
        }
    }

    // ── フェイク ──────────────────────────────────────────────────────────────

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Event {
        Started(ProcessStarted),
        Output(ProcessOutput),
        Finished(ProcessFinished),
    }

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<Event>>,
    }

    impl RecordingSink {
        fn events(&self) -> Vec<Event> {
            self.events.lock().unwrap().clone()
        }

        fn outputs(&self, stream: Stream) -> Vec<ProcessOutput> {
            self.events()
                .into_iter()
                .filter_map(|e| match e {
                    Event::Output(o) if o.stream == stream => Some(o),
                    _ => None,
                })
                .collect()
        }
    }

    impl EventSink for RecordingSink {
        fn started(&self, event: &ProcessStarted) {
            self.events
                .lock()
                .unwrap()
                .push(Event::Started(event.clone()));
        }

        fn output(&self, event: &ProcessOutput) {
            self.events
                .lock()
                .unwrap()
                .push(Event::Output(event.clone()));
        }

        fn finished(&self, event: &ProcessFinished) {
            self.events
                .lock()
                .unwrap()
                .push(Event::Finished(event.clone()));
        }
    }

    struct Script {
        stdout: &'static [u8],
        stderr: &'static [u8],
        exit: Option<i32>,
        /// true のとき、terminate が呼ばれるまで wait を終えない。
        hold: bool,
    }

    impl Script {
        fn finishing(stdout: &'static [u8], stderr: &'static [u8], exit: i32) -> Self {
            Self {
                stdout,
                stderr,
                exit: Some(exit),
                hold: false,
            }
        }

        fn held() -> Self {
            Self {
                stdout: b"",
                stderr: b"",
                exit: None,
                hold: true,
            }
        }
    }

    #[derive(Default)]
    struct FakeLauncher {
        scripts: Mutex<Vec<io::Result<Script>>>,
        launches: AtomicU64,
        terminates: Arc<AtomicU64>,
    }

    impl FakeLauncher {
        fn with(scripts: Vec<io::Result<Script>>) -> Arc<Self> {
            Arc::new(Self {
                scripts: Mutex::new(scripts),
                ..Self::default()
            })
        }
    }

    impl Launcher for FakeLauncher {
        fn launch(&self, _spec: &LaunchSpec) -> io::Result<Launched> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            let script = self.scripts.lock().unwrap().remove(0)?;
            let (release_tx, release_rx) = mpsc::channel::<()>();
            let release_tx = Mutex::new(release_tx);
            let terminates = Arc::clone(&self.terminates);
            let exit = script.exit;
            let hold = script.hold;
            Ok(Launched {
                stdout: Box::new(Cursor::new(script.stdout)),
                stderr: Box::new(Cursor::new(script.stderr)),
                wait: Box::new(move || {
                    if hold {
                        let _ = release_rx.recv();
                    }
                    Ok(exit)
                }),
                terminate: Arc::new(move || {
                    terminates.fetch_add(1, Ordering::SeqCst);
                    let _ = release_tx.lock().unwrap().send(());
                }),
            })
        }
    }

    fn spec() -> LaunchSpec {
        LaunchSpec {
            program: "fake".to_string(),
            args: vec!["--flag".to_string()],
            cwd: PathBuf::from("."),
        }
    }

    fn runner(launcher: &Arc<FakeLauncher>, sink: &Arc<RecordingSink>) -> Arc<Runner> {
        Arc::new(Runner::new(
            Arc::clone(launcher) as Arc<dyn Launcher>,
            Arc::clone(sink) as Arc<dyn EventSink>,
        ))
    }

    fn wait_until(mut condition: impl FnMut() -> bool) {
        for _ in 0..500 {
            if condition() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("condition was not met within 5s");
    }

    // ── Runner ────────────────────────────────────────────────────────────────

    #[test]
    fn run_streams_both_streams_between_started_and_finished() {
        let launcher = FakeLauncher::with(vec![Ok(Script::finishing(b"a\nb\n", b"warn\n", 0))]);
        let sink = Arc::new(RecordingSink::default());

        let outcome = runner(&launcher, &sink).run("fake run", spec()).unwrap();

        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.cancelled);
        assert_eq!(outcome.stdout, "a\nb");
        assert_eq!(outcome.stderr, "warn");

        let events = sink.events();
        let Some(Event::Started(started)) = events.first() else {
            panic!("first event must be started: {events:?}");
        };
        assert_eq!(started.label, "fake run");
        assert_eq!(started.argv, vec!["fake", "--flag"]);
        assert!(
            matches!(events.last(), Some(Event::Finished(f)) if f.exit_code == Some(0) && !f.cancelled)
        );
        let stdout: Vec<_> = sink
            .outputs(Stream::Stdout)
            .into_iter()
            .map(|o| o.text)
            .collect();
        assert_eq!(stdout, vec!["a", "b"]);
        let stderr: Vec<_> = sink
            .outputs(Stream::Stderr)
            .into_iter()
            .map(|o| o.text)
            .collect();
        assert_eq!(stderr, vec!["warn"]);
    }

    #[test]
    fn run_reports_nonzero_exit_code() {
        let launcher = FakeLauncher::with(vec![Ok(Script::finishing(b"", b"boom\n", 3))]);
        let sink = Arc::new(RecordingSink::default());

        let outcome = runner(&launcher, &sink).run("x", spec()).unwrap();

        assert_eq!(outcome.exit_code, Some(3));
        assert_eq!(outcome.stderr, "boom");
    }

    #[test]
    fn run_collapses_progress_lines_in_collected_output() {
        let launcher = FakeLauncher::with(vec![Ok(Script::finishing(b"10%\r20%\rdone\n", b"", 0))]);
        let sink = Arc::new(RecordingSink::default());

        let outcome = runner(&launcher, &sink).run("x", spec()).unwrap();

        assert_eq!(outcome.stdout, "done");
        let flags: Vec<_> = sink
            .outputs(Stream::Stdout)
            .into_iter()
            .map(|o| o.overwrite)
            .collect();
        assert_eq!(flags, vec![false, true, true]);
    }

    #[test]
    fn run_rejects_a_second_command_while_one_is_running() {
        let launcher = FakeLauncher::with(vec![Ok(Script::held())]);
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&launcher, &sink);

        let first = {
            let runner = Arc::clone(&runner);
            std::thread::spawn(move || runner.run("first", spec()))
        };
        wait_until(|| launcher.launches.load(Ordering::SeqCst) == 1);

        let second = runner.run("second", spec());
        assert!(second.unwrap_err().contains("別のコマンドを実行中"));
        // 拒否した 2 件目は起動していない。
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);

        let run_id = match sink.events().first() {
            Some(Event::Started(s)) => s.run_id,
            other => panic!("expected started: {other:?}"),
        };
        runner.cancel(run_id).unwrap();
        first.join().unwrap().unwrap();
    }

    #[test]
    fn cancel_terminates_and_marks_the_run_cancelled() {
        let launcher = FakeLauncher::with(vec![Ok(Script::held())]);
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&launcher, &sink);

        let handle = {
            let runner = Arc::clone(&runner);
            std::thread::spawn(move || runner.run("long", spec()))
        };
        wait_until(|| matches!(sink.events().first(), Some(Event::Started(_))));
        let Some(Event::Started(started)) = sink.events().first().cloned() else {
            panic!("started event expected");
        };

        runner.cancel(started.run_id).unwrap();
        let outcome = handle.join().unwrap().unwrap();

        assert!(outcome.cancelled);
        assert_eq!(launcher.terminates.load(Ordering::SeqCst), 1);
        assert!(matches!(
            sink.events().last(),
            Some(Event::Finished(f)) if f.cancelled && f.run_id == started.run_id
        ));
    }

    #[test]
    fn cancel_rejects_unknown_or_finished_runs() {
        let launcher = FakeLauncher::with(vec![Ok(Script::finishing(b"", b"", 0))]);
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&launcher, &sink);

        assert!(runner.cancel(99).is_err());
        runner.run("x", spec()).unwrap();
        // 終了済みの run はキャンセルできない。
        assert!(runner.cancel(1).is_err());
    }

    #[test]
    fn failed_launch_releases_the_slot() {
        let launcher = FakeLauncher::with(vec![
            Err(io::Error::new(io::ErrorKind::NotFound, "no such program")),
            Ok(Script::finishing(b"ok\n", b"", 0)),
        ]);
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&launcher, &sink);

        let err = runner.run("x", spec()).unwrap_err();
        assert!(err.contains("Failed to spawn fake"), "{err}");
        // 起動に失敗した run は started も finished も出さない。
        assert!(sink.events().is_empty());

        assert_eq!(runner.run("x", spec()).unwrap().stdout, "ok");
    }

    // ── SystemLauncher（実プロセス）─────────────────────────────────────────────

    #[cfg(windows)]
    fn long_running() -> LaunchSpec {
        // cmd の子として ping.exe が走る。ツリーごと止められなければ、ping の終了まで出力パイプが閉じない。
        LaunchSpec {
            program: "cmd".to_string(),
            args: vec!["/C".into(), "ping -n 30 127.0.0.1".into()],
            cwd: PathBuf::from("."),
        }
    }

    #[cfg(unix)]
    fn long_running() -> LaunchSpec {
        LaunchSpec {
            program: "sh".to_string(),
            args: vec!["-c".into(), "sleep 30; echo done".into()],
            cwd: PathBuf::from("."),
        }
    }

    #[cfg(windows)]
    fn echo_hello() -> LaunchSpec {
        LaunchSpec {
            program: "cmd".to_string(),
            args: vec!["/C".into(), "echo hello".into()],
            cwd: PathBuf::from("."),
        }
    }

    #[cfg(unix)]
    fn echo_hello() -> LaunchSpec {
        LaunchSpec {
            program: "sh".to_string(),
            args: vec!["-c".into(), "echo hello".into()],
            cwd: PathBuf::from("."),
        }
    }

    fn system_runner(sink: &Arc<RecordingSink>) -> Arc<Runner> {
        Arc::new(Runner::new(
            Arc::new(SystemLauncher),
            Arc::clone(sink) as Arc<dyn EventSink>,
        ))
    }

    #[test]
    fn system_launcher_captures_real_output() {
        let sink = Arc::new(RecordingSink::default());

        let outcome = system_runner(&sink).run("echo", echo_hello()).unwrap();

        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(outcome.stdout.trim(), "hello");
    }

    #[test]
    fn system_launcher_missing_program_is_reported() {
        let sink = Arc::new(RecordingSink::default());
        let missing = LaunchSpec {
            program: "arbor-no-such-program".to_string(),
            args: vec![],
            cwd: PathBuf::from("."),
        };

        let err = system_runner(&sink).run("x", missing).unwrap_err();

        assert!(
            err.contains("Failed to spawn arbor-no-such-program"),
            "{err}"
        );
    }

    #[test]
    fn system_launcher_cancel_kills_the_whole_process_tree() {
        let sink = Arc::new(RecordingSink::default());
        let runner = system_runner(&sink);

        let started_at = Instant::now();
        let handle = {
            let runner = Arc::clone(&runner);
            std::thread::spawn(move || runner.run("long", long_running()))
        };
        wait_until(|| matches!(sink.events().first(), Some(Event::Started(_))));
        // 孫プロセスが起動するのを待ってから止める。
        std::thread::sleep(Duration::from_millis(500));
        let Some(Event::Started(started)) = sink.events().first().cloned() else {
            panic!("started event expected");
        };

        runner.cancel(started.run_id).unwrap();
        let outcome = handle.join().unwrap().unwrap();

        assert!(outcome.cancelled);
        // 孫が生き残ると、出力パイプが閉じるまで（約 30 秒）読み取りが終わらない。
        assert!(
            started_at.elapsed() < Duration::from_secs(15),
            "process tree was not terminated: {:?}",
            started_at.elapsed()
        );
    }
}
