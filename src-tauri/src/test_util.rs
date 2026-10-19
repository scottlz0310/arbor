//! テスト用の共通の補助。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 一時ディレクトリの名前に付ける、重ならない接尾辞。
/// 時刻だけでは、時計の分解能が低い環境（macOS はマイクロ秒）で、並列のテストが同じ名前を作ってしまう。
/// 連番を足して、同じプロセスの中で必ず別の名前にする。
pub fn unique_suffix() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_nanos();
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::unique_suffix;
    use std::collections::HashSet;

    #[test]
    fn unique_suffix_never_repeats_even_when_called_in_a_tight_loop() {
        let suffixes: HashSet<_> = (0..1_000).map(|_| unique_suffix()).collect();

        assert_eq!(suffixes.len(), 1_000);
    }
}
