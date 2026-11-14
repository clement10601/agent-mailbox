use serde::Serialize;

/// Error codes agents may see in a tool error. The set is part of the public contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UnknownRecipient,
    Blocked,
    InboxFull,
    QuotaExceeded,
    TooLarge,
    InvalidInput,
    InvalidReplyTo,
    NotFound,
    RateLimited,
    Unauthorized,
    Internal,
}

/// The `{ code, message, hint, retry_after? }` shape returned to agents.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolError {
    pub code: ErrorCode,
    pub message: String,
    pub hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u32>,
}

/// Everything that can go wrong inside the worker. `Mailbox` errors are expected and shown to agents as-is;
/// `Internal` errors are logged and shown only as a generic "internal".
#[derive(Debug)]
pub enum Error {
    Mailbox(ToolError),
    Internal(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Error::Mailbox(ToolError { code, message: message.into(), hint: hint.into(), retry_after: None })
    }

    pub fn with_retry(code: ErrorCode, message: impl Into<String>, hint: impl Into<String>, retry_after: u32) -> Self {
        Error::Mailbox(ToolError { code, message: message.into(), hint: hint.into(), retry_after: Some(retry_after) })
    }

    pub fn invalid(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message, hint)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Error::Internal(message.into())
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            Error::Mailbox(e) => e.code,
            Error::Internal(_) => ErrorCode::Internal,
        }
    }

    /// What an agent sees. Internal details never leak.
    pub fn to_tool_error(&self) -> ToolError {
        match self {
            Error::Mailbox(e) => e.clone(),
            Error::Internal(_) => internal_tool_error(),
        }
    }
}

pub fn internal_tool_error() -> ToolError {
    ToolError {
        code: ErrorCode::Internal,
        message: "Internal error.".into(),
        hint: "Retry later; if it persists, contact the operator.".into(),
        retry_after: None,
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Mailbox(e) => write!(f, "{:?}: {}", e.code, e.message),
            Error::Internal(m) => write!(f, "internal: {m}"),
        }
    }
}

impl From<worker::Error> for Error {
    fn from(e: worker::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_mailbox_errors() {
        let e = Error::with_retry(ErrorCode::RateLimited, "slow down", "wait", 60);
        let v = serde_json::to_value(e.to_tool_error()).unwrap();
        assert_eq!(v, serde_json::json!({"code":"rate_limited","message":"slow down","hint":"wait","retry_after":60}));
    }

    #[test]
    fn omits_retry_after_when_absent() {
        let v = serde_json::to_value(Error::new(ErrorCode::NotFound, "m", "h").to_tool_error()).unwrap();
        assert!(v.get("retry_after").is_none());
    }

    #[test]
    fn hides_internal_errors() {
        let t = Error::internal("D1 exploded at row 7").to_tool_error();
        assert_eq!(t.code, ErrorCode::Internal);
        assert!(!t.message.contains("D1"));
    }
}
