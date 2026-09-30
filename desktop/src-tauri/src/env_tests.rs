use super::*;

#[test]
fn quotes_single_quotes() {
    assert_eq!(sh_quote("/a b/it's"), "'/a b/it'\\''s'");
}

thread_local! {
    pub(super) static KILLPG_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn fresh() -> LoginPathCache {
    LoginPathCache::new()
}

#[test]
fn login_path_failure_is_retried_later_success_is_kept() {
    let t0 = Instant::now();
    let mut c = fresh();
    assert_eq!(c.poll(t0), (None, true), "first poll starts a read");
    assert_eq!(c.poll(t0), (None, false), "one read at a time");
    c.finish(t0, None);
    assert_eq!(c.poll(t0 + Duration::from_secs(10)), (None, false), "backs off after a failure");
    assert_eq!(c.poll(t0 + LOGIN_PATH_RETRY), (None, true));
    c.finish(t0 + LOGIN_PATH_RETRY, Some("/a:/b".into()));
    assert_eq!(c.poll(t0 + LOGIN_PATH_RETRY * 5), (Some("/a:/b".into()), false), "success is kept");
}

#[test]
fn login_path_needs_a_clean_exit_and_both_markers() {
    let out = "motd\n__CSPATH__/bad/path__CSPATH__\n".to_string();
    assert_eq!(login_path_from(Ok((true, out.clone(), String::new()))).as_deref(), Some("/bad/path"));
    assert_eq!(login_path_from(Ok((false, out, "rc error".into()))), None, "markers printed, then exit 7");
    assert_eq!(login_path_from(Ok((true, "__CSPATH__/cut".into(), String::new()))), None);
    assert_eq!(login_path_from(Err(RunError::Started("timed out after 5s".into()))), None);
}

#[test]
fn failed_login_shell_exit_is_not_cached() {
    let t0 = Instant::now();
    let mut c = fresh();
    let marked = || "__CSPATH__/half:/built__CSPATH__".to_string();
    c.poll(t0);
    c.finish(t0, login_path_from(Ok((false, marked(), String::new()))));
    assert_eq!(c.poll(t0 + LOGIN_PATH_RETRY), (None, true), "not cached, retried after the back-off");
    c.finish(t0 + LOGIN_PATH_RETRY, login_path_from(Ok((true, marked(), String::new()))));
    assert_eq!(c.poll(t0 + LOGIN_PATH_RETRY).0.as_deref(), Some("/half:/built"));
}

/// Through a real child process: a throwaway script stands in for the login shell (setting
/// SHELL would race other tests), so the exit status really comes from run_with_timeout.
#[test]
fn real_shell_printing_markers_then_failing_is_rejected() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("cs-t18b-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sh = dir.join("fake-shell");
    std::fs::write(&sh, "#!/bin/sh\nprintf '\\n__CSPATH__/bad/path__CSPATH__\\n'\nexit 7\n").unwrap();
    std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o700)).unwrap();
    let r = run_with_timeout(&mut Command::new(&sh), Duration::from_secs(5));
    // best-effort: a leftover dir in the per-user temp folder is harmless
    let _ = std::fs::remove_dir_all(&dir);
    assert!(matches!(&r, Ok((false, out, _)) if out.contains("__CSPATH__/bad/path")), "{r:?}");
    assert_eq!(login_path_from(r), None);
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks existence
    unsafe { libc::kill(pid, 0) == 0 }
}

fn bg_job(script_tail: &str, name: &str) -> (Result<(bool, String, String), RunError>, Duration, i32) {
    let pidfile = std::env::temp_dir().join(format!("cs-t18b-{name}-{}", std::process::id()));
    let script = format!("{script_tail} & echo $! > '{}'; exit 0", pidfile.display());
    let t0 = Instant::now();
    let r = run_with_timeout(Command::new("/bin/sh").args(["-c", &script]), Duration::from_millis(300));
    let took = t0.elapsed();
    let pid = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    // best-effort cleanup of the pid file in the per-user temp folder
    let _ = std::fs::remove_file(&pidfile);
    (r, took, pid)
}

/// The leader exits at once and is reaped; its background job keeps stdout open. The deadline
/// must hold, and no signal may go to the dead leader's group id (it may be reused).
#[test]
fn descendant_holding_the_pipe_after_the_leader_is_reaped_is_left_alone() {
    let before = KILLPG_CALLS.with(|c| c.get());
    let (r, took, pid) = bg_job("sleep 30", "stay");
    assert!(matches!(r, Err(RunError::Started(_))), "{r:?}");
    assert!(took < Duration::from_secs(2), "took {took:?}");
    assert_eq!(KILLPG_CALLS.with(|c| c.get()), before, "no killpg after the leader was reaped");
    assert!(alive(pid), "the stray job is abandoned, not signalled");
    // SAFETY: our own test child, confirmed alive just above
    unsafe { libc::kill(pid, libc::SIGKILL) };
}

/// Same, with a descendant that left the group: the case where the old group id is free.
#[test]
fn descendant_that_left_the_group_is_left_alone() {
    let before = KILLPG_CALLS.with(|c| c.get());
    let (r, took, pid) = bg_job("perl -e 'use POSIX; setsid(); sleep 30'", "setsid");
    assert!(matches!(r, Err(RunError::Started(_))), "{r:?}");
    assert!(took < Duration::from_secs(2), "took {took:?}");
    assert_eq!(KILLPG_CALLS.with(|c| c.get()), before);
    // SAFETY: our own test child (kill on a gone pid is a harmless ESRCH)
    unsafe { libc::kill(pid, libc::SIGKILL) };
}

/// Leader still running at the deadline: its group is killed (safe, it isn't reaped yet).
#[test]
fn hung_leader_and_its_group_are_killed() {
    let before = KILLPG_CALLS.with(|c| c.get());
    let t0 = Instant::now();
    let r = run_with_timeout(Command::new("/bin/sh").args(["-c", "sleep 30 & sleep 30"]), Duration::from_millis(300));
    assert!(matches!(r, Err(RunError::Started(_))), "{r:?}");
    assert!(t0.elapsed() < Duration::from_secs(2));
    assert_eq!(KILLPG_CALLS.with(|c| c.get()), before + 1);
}

#[test]
fn normal_run_still_returns_output_and_status() {
    let r = run_with_timeout(Command::new("/bin/sh").args(["-c", "echo out; echo err >&2; exit 3"]), Duration::from_secs(5));
    let (ok, out, err) = r.expect("ran");
    assert!(!ok);
    assert_eq!((out.trim(), err.trim()), ("out", "err"));
}

/// Runs the user's real interactive login shell (reads their rc files), so not by default:
/// `cargo test -- --ignored real_login_shell`. Checks setsid (no controlling tty) still works.
#[test]
#[ignore]
fn real_login_shell_path_is_read() {
    let p = read_login_shell_path().expect("login shell PATH");
    assert!(p.contains("/usr/bin"), "{p}");
}

#[test]
fn extra_dirs_are_appended_once() {
    let p = with_extra_dirs("/opt/homebrew/bin:/x");
    assert_eq!(p.matches("/opt/homebrew/bin").count(), 1);
    assert!(p.starts_with("/opt/homebrew/bin:/x:"));
}
