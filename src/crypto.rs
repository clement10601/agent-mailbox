use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("random source unavailable");
    b
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256(s: &str) -> [u8; 32] {
    Sha256::digest(s.as_bytes()).into()
}

pub fn sha256_hex(s: &str) -> String {
    hex(&sha256(s))
}

/// Compares two secrets without leaking where they differ: both are hashed first, so the comparison
/// always runs over 32 bytes whatever the inputs' lengths.
pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    let (ha, hb) = (sha256(a), sha256(b));
    ha.iter().zip(hb.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// An agent key: `amk_` followed by 32 random bytes, base64url.
pub fn generate_key() -> String {
    format!("amk_{}", b64url(&random_bytes::<32>()))
}

/// A one-time binding code for the OAuth consent page: `amb_` followed by 32 random bytes, base64url.
pub fn generate_binding_code() -> String {
    format!("amb_{}", b64url(&random_bytes::<32>()))
}

/// 16 lowercase hex characters, for message, thread and key ids.
pub fn new_id() -> String {
    hex(&random_bytes::<8>())
}

/// Unguessable URL-safe token (32 random bytes).
pub fn random_token() -> String {
    b64url(&random_bytes::<32>())
}

/// PKCE S256: base64url(sha256(verifier)).
pub fn pkce_s256(verifier: &str) -> String {
    b64url(&sha256(verifier))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format_and_uniqueness() {
        let k = generate_key();
        assert!(k.starts_with("amk_"));
        assert_eq!(k.len(), 4 + 43);
        assert_ne!(k, generate_key());
    }

    #[test]
    fn sha256_hex_known_value() {
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn timing_safe_eq_works() {
        assert!(timing_safe_eq("secret", "secret"));
        assert!(!timing_safe_eq("secret", "secreT"));
        assert!(!timing_safe_eq("secret", "secret-longer"));
    }

    #[test]
    fn new_id_is_16_hex() {
        let id = new_id();
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn pkce_s256_matches_openssl() {
        assert_eq!(pkce_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
