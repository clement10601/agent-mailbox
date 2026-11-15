//! Public, crawlable pages: the landing page, the SAMP overview, robots.txt and sitemap.xml.
//!
//! Every absolute URL (canonical, Open Graph, sitemap) uses one public origin: `PUBLIC_ORIGIN` when it is set
//! to a valid origin, otherwise the origin the request arrived on. Setting it makes the workers.dev copy of a
//! page name the custom domain as canonical, so search engines index one address.

use worker::Response;

use crate::errors::Result;

const STYLE: &str = include_str!("site.css");
const LANDING: &str = include_str!("landing.html");
const SAMP: &str = include_str!("samp.html");

/// Paths listed in the sitemap, relative to the public origin.
const PAGES: [&str; 2] = ["/", "/samp"];

/// `configured` wins when it is an `https://host` origin (a trailing slash is tolerated); anything else falls
/// back to the request origin.
pub fn public_origin(configured: Option<&str>, request_origin: &str) -> String {
    let c = configured.map(str::trim).unwrap_or_default().trim_end_matches('/');
    let host = c.strip_prefix("https://").unwrap_or_default();
    let valid = !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'));
    if valid { c.to_string() } else { request_origin.to_string() }
}

fn render(template: &str, origin: &str) -> String {
    template.replace("{{STYLE}}", STYLE).replace("{{ORIGIN}}", origin)
}

pub fn robots(origin: &str) -> String {
    format!("User-agent: *\nAllow: /\nDisallow: /mcp\nDisallow: /authorize\nDisallow: /register\nDisallow: /token\n\nSitemap: {origin}/sitemap.xml\n")
}

pub fn sitemap(origin: &str) -> String {
    let urls: String = PAGES.iter().map(|p| format!("  <url><loc>{origin}{p}</loc></url>\n")).collect();
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>\n")
}

fn respond(body: String, content_type: &str) -> Result<Response> {
    let mut res = Response::ok(body)?;
    let h = res.headers_mut();
    h.set("content-type", content_type)?;
    h.set("cache-control", "public, max-age=3600")?;
    Ok(res)
}

/// The response for a public page, or `None` when `path` is not one.
pub fn page(path: &str, origin: &str) -> Result<Option<Response>> {
    let res = match path {
        "/" => respond(render(LANDING, origin), "text/html; charset=utf-8")?,
        "/samp" => respond(render(SAMP, origin), "text/html; charset=utf-8")?,
        "/robots.txt" => respond(robots(origin), "text/plain; charset=utf-8")?,
        "/sitemap.xml" => respond(sitemap(origin), "application/xml; charset=utf-8")?,
        _ => return Ok(None),
    };
    Ok(Some(res))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_origin_prefers_valid_config() {
        assert_eq!(public_origin(Some("https://a.example"), "https://w.dev"), "https://a.example");
        assert_eq!(public_origin(Some(" https://a.example/ "), "https://w.dev"), "https://a.example");
        for bad in [None, Some(""), Some("a.example"), Some("http://a.example"), Some("https://a.example/x"), Some("https://a\"b")] {
            assert_eq!(public_origin(bad, "https://w.dev"), "https://w.dev", "{bad:?}");
        }
    }

    #[test]
    fn templates_are_fully_rendered() {
        for t in [LANDING, SAMP] {
            let html = render(t, "https://a.example");
            assert!(!html.contains("{{"));
            assert!(html.contains("<link rel=\"canonical\" href=\"https://a.example/"));
            assert!(html.contains("application/ld+json"));
        }
    }

    #[test]
    fn robots_and_sitemap_use_the_origin() {
        assert!(robots("https://a.example").contains("Sitemap: https://a.example/sitemap.xml"));
        let s = sitemap("https://a.example");
        assert!(s.contains("<loc>https://a.example/</loc>") && s.contains("<loc>https://a.example/samp</loc>"));
    }
}
