//! Subscription plans and the usage period. Pure: no D1, no clock.

use serde::Serialize;

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Plan {
    Free,
    Pro,
    Team,
}

/// What an account may use. Enforced only when BILLING_ENABLED is true.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Active (not disabled) agents.
    pub max_agents: i64,
    /// Messages accepted for delivery per period; a broadcast counts once per recipient.
    pub monthly_messages: i64,
}

pub const PLAN_NAMES: [&str; 3] = ["free", "pro", "team"];

impl Plan {
    pub fn parse(s: &str) -> Option<Plan> {
        match s.trim().to_lowercase().as_str() {
            "free" => Some(Plan::Free),
            "pro" => Some(Plan::Pro),
            "team" => Some(Plan::Team),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Plan::Free => "free",
            Plan::Pro => "pro",
            Plan::Team => "team",
        }
    }

    pub fn limits(self) -> Limits {
        match self {
            Plan::Free => Limits { max_agents: 3, monthly_messages: 1_000 },
            Plan::Pro => Limits { max_agents: 20, monthly_messages: 50_000 },
            Plan::Team => Limits { max_agents: 100, monthly_messages: 500_000 },
        }
    }
}

/// Days since the epoch -> (year, month 1-12). Proleptic Gregorian, UTC.
fn year_month(days: i64) -> (i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m)
}

/// (year, month 1-12) -> days since the epoch of the first of that month.
fn first_of_month(y: i64, m: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The usage period a time falls in: its UTC calendar month, as "YYYY-MM".
pub fn period(ms: i64) -> String {
    let (y, m) = year_month(ms.div_euclid(DAY_MS));
    format!("{y:04}-{m:02}")
}

/// When the period containing `ms` ends and counters start again from zero.
pub fn period_end_ms(ms: i64) -> i64 {
    let (y, m) = year_month(ms.div_euclid(DAY_MS));
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    first_of_month(ny, nm) * DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plans() {
        assert_eq!(Plan::parse(" Pro "), Some(Plan::Pro));
        assert_eq!(Plan::parse("enterprise"), None);
        for n in PLAN_NAMES {
            assert_eq!(Plan::parse(n).unwrap().as_str(), n);
        }
    }

    #[test]
    fn limits_grow_with_the_plan() {
        let (f, p, t) = (Plan::Free.limits(), Plan::Pro.limits(), Plan::Team.limits());
        assert!(f.max_agents < p.max_agents && p.max_agents < t.max_agents);
        assert!(f.monthly_messages < p.monthly_messages && p.monthly_messages < t.monthly_messages);
    }

    #[test]
    fn periods() {
        assert_eq!(period(0), "1970-01");
        // 2026-11-14T12:39:36Z
        assert_eq!(period(1_794_659_976_000), "2026-11");
        // 2024-02-29T23:59:59.999Z and the next millisecond
        assert_eq!(period(1_709_251_199_999), "2024-02");
        assert_eq!(period(1_709_251_200_000), "2024-03");
        // 2026-12-31T23:59:59.999Z rolls into the next year
        assert_eq!(period(1_798_761_599_999), "2026-12");
        assert_eq!(period(1_798_761_600_000), "2027-01");
    }

    #[test]
    fn period_ends_at_the_first_of_next_month() {
        assert_eq!(period_end_ms(0), 31 * DAY_MS);
        assert_eq!(period_end_ms(1_709_251_199_999), 1_709_251_200_000);
        assert_eq!(period_end_ms(1_794_659_976_000), 1_796_083_200_000); // 2026-12-01T00:00:00Z
        assert_eq!(period_end_ms(1_798_761_599_999), 1_798_761_600_000);
        let end = period_end_ms(1_794_659_976_000);
        assert_eq!(period(end - 1), "2026-11");
        assert_eq!(period(end), "2026-12");
    }
}
