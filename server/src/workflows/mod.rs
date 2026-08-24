//! Workflows — a bot, an ORDERED list of prompt steps, a trigger, and a typed
//! completion action.
//!
//! The successor to `scheduler/`. This module is being built out in phases; for
//! now it owns only the post-upgrade reconciliation that runs once at boot
//! after migration `0038_workflows.sql` has ported the old `schedules` rows.

pub mod port;
