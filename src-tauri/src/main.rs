#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Instant;

use base64::Engine;
use serde::Serialize;
use tauri::State;
use tokio::process::Command;
use tokio::sync::oneshot;

/// Bodies larger than this are truncated before being sent to the UI.
const MAX_BODY: usize = 32 * 1024 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Cancellation handles for in-flight requests, keyed by request id.
#[derive(Default)]
struct Inflight(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CurlResult {
    exit_code: Option<i32>,
    stderr: String,
    /// stdout: one `%{json}` line per transfer
    meta: String,
    /// raw response headers (every hop when following redirects)
    headers: String,
    body: String,
    body_encoding: &'static str,
    body_size: usize,
    truncated: bool,
    elapsed_ms: u128,
}

fn curl_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("CURLMAN_CURL") {
        return p.into();
    }
    #[cfg(windows)]
    {
        // Prefer the curl.exe that ships with Windows over whatever is first on PATH.
        if let Some(root) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(root).join("System32").join("curl.exe");
            if p.exists() {
                return p;
            }
        }
    }
    PathBuf::from("curl")
}

fn command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn encode_body(bytes: &[u8]) -> (String, &'static str) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_owned(), "utf8"),
        // valid UTF-8 cut off mid-character by truncation
        Err(e) if e.error_len().is_none() && e.valid_up_to() + 4 > bytes.len() => {
            (String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned(), "utf8")
        }
        Err(_) => (base64::engine::general_purpose::STANDARD.encode(bytes), "base64"),
    }
}

/// Runs curl with `args`, capturing headers, body and `%{json}` metadata.
/// Resolves to `Err("cancelled")` if `cancel` fires first.
async fn execute(
    bin: &Path,
    id: &str,
    args: &[String],
    cancel: oneshot::Receiver<()>,
) -> Result<CurlResult, String> {
    let safe_id: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect();
    let tmp = std::env::temp_dir();
    let tag = format!("curlman-{}-{}", std::process::id(), safe_id);
    let header_path = tmp.join(format!("{tag}.headers"));
    let body_path = tmp.join(format!("{tag}.body"));

    let mut cmd = command(bin);
    cmd.args(args)
        .arg("--silent")
        .arg("--show-error")
        .arg("--dump-header")
        .arg(&header_path)
        .arg("--output")
        .arg(&body_path)
        .arg("--write-out")
        .arg("%{json}\\n")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let start = Instant::now();
    let outcome = match cmd.spawn() {
        Ok(child) => tokio::select! {
            out = child.wait_with_output() => Some(out.map_err(|e| e.to_string())),
            // dropping the wait future drops (and kills) the child
            _ = cancel => None,
        },
        Err(e) => Some(Err(format!(
            "Could not start curl ({}): {e}. Is curl installed and on your PATH?",
            bin.display()
        ))),
    };
    let elapsed_ms = start.elapsed().as_millis();

    let headers = tokio::fs::read(&header_path).await.unwrap_or_default();
    let body = tokio::fs::read(&body_path).await.unwrap_or_default();
    let _ = tokio::fs::remove_file(&header_path).await;
    let _ = tokio::fs::remove_file(&body_path).await;

    let output = match outcome {
        None => return Err("cancelled".into()),
        Some(Err(e)) => return Err(e),
        Some(Ok(o)) => o,
    };

    let body_size = body.len();
    let truncated = body_size > MAX_BODY;
    let (body, body_encoding) = encode_body(&body[..body_size.min(MAX_BODY)]);

    Ok(CurlResult {
        exit_code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        meta: String::from_utf8_lossy(&output.stdout).into_owned(),
        headers: String::from_utf8_lossy(&headers).into_owned(),
        body,
        body_encoding,
        body_size,
        truncated,
        elapsed_ms,
    })
}

#[tauri::command]
async fn run_curl(
    id: String,
    args: Vec<String>,
    inflight: State<'_, Inflight>,
) -> Result<CurlResult, String> {
    let (tx, rx) = oneshot::channel();
    inflight.0.lock().unwrap().insert(id.clone(), tx);
    let result = execute(&curl_bin(), &id, &args, rx).await;
    inflight.0.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
fn cancel_curl(id: String, inflight: State<'_, Inflight>) {
    if let Some(tx) = inflight.0.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

#[tauri::command]
async fn curl_version() -> Result<String, String> {
    let out = command(&curl_bin())
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned())
}

fn main() {
    tauri::Builder::default()
        .manage(Inflight::default())
        .invoke_handler(tauri::generate_handler![run_curl, cancel_curl, curl_version])
        .run(tauri::generate_context!())
        .expect("error while running Curlman");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Serves one connection, answering with `response` after `delay_ms`.
    fn serve(response: Vec<u8>, delay_ms: u64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Some(Ok(mut s)) = listener.incoming().next() {
                let mut buf = [0u8; 8192];
                let mut req = Vec::new();
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    req.extend_from_slice(&buf[..n]);
                }
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                let _ = s.write_all(&response);
            }
        });
        format!("http://{addr}/")
    }

    fn http(status: &str, ctype: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    async fn run(args: &[&str]) -> Result<CurlResult, String> {
        let (_tx, rx) = oneshot::channel();
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        execute(&curl_bin(), "test", &args, rx).await
    }

    #[tokio::test]
    async fn captures_status_headers_body_and_meta() {
        let url = serve(http("200 OK", "application/json", br#"{"id":12345678901234567890}"#), 0);
        let r = run(&[&url]).await.unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert!(r.headers.starts_with("HTTP/1.1 200 OK"), "{}", r.headers);
        assert_eq!(r.body, r#"{"id":12345678901234567890}"#);
        assert_eq!(r.body_encoding, "utf8");
        assert!(r.meta.contains("\"response_code\":200"), "{}", r.meta);
        assert!(!r.truncated);
    }

    #[tokio::test]
    async fn binary_body_is_base64() {
        let url = serve(http("200 OK", "image/png", &[0xff, 0x00, 0x89]), 0);
        let r = run(&[&url]).await.unwrap();
        assert_eq!(r.body_encoding, "base64");
        assert_eq!(r.body, "/wCJ");
        assert_eq!(r.body_size, 3);
    }

    #[tokio::test]
    async fn http_error_status_is_still_a_response() {
        let url = serve(http("503 Service Unavailable", "text/plain", b"down"), 0);
        let r = run(&[&url]).await.unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert!(r.meta.contains("\"response_code\":503"));
        assert_eq!(r.body, "down");
    }

    #[tokio::test]
    async fn connection_failure_reports_curl_error() {
        // bind then drop to get a port nothing listens on
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let r = run(&[&format!("http://127.0.0.1:{port}/")]).await.unwrap();
        assert_eq!(r.exit_code, Some(7));
        assert!(r.stderr.contains("curl: (7)"), "{}", r.stderr);
    }

    #[tokio::test]
    async fn cancel_stops_a_slow_request() {
        let url = serve(http("200 OK", "text/plain", b"late"), 10_000);
        let (tx, rx) = oneshot::channel();
        let args = vec![url];
        let started = Instant::now();
        let handle = tokio::spawn(async move { execute(&curl_bin(), "cancel", &args, rx).await });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        tx.send(()).unwrap();
        let r = handle.await.unwrap();
        assert_eq!(r.err().as_deref(), Some("cancelled"));
        assert!(started.elapsed().as_secs() < 3);
    }

    #[tokio::test]
    async fn missing_binary_is_a_clear_error() {
        let (_tx, rx) = oneshot::channel();
        let e = execute(Path::new("definitely-not-curl-xyz"), "x", &["x".into()], rx)
            .await
            .err()
            .unwrap();
        assert!(e.starts_with("Could not start curl"), "{e}");
    }

    #[test]
    fn encode_body_handles_truncated_utf8() {
        let bytes = "ab\u{20ac}".as_bytes();
        assert_eq!(encode_body(&bytes[..bytes.len() - 1]), ("ab".to_string(), "utf8"));
        assert_eq!(encode_body(&[0xff, 0x00]).1, "base64");
        assert_eq!(encode_body("h\u{e9}llo".as_bytes()), ("h\u{e9}llo".to_string(), "utf8"));
    }
}
