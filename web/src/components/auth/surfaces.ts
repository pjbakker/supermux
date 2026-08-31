// The two NON-OWNER arrival surfaces, in ONE lazy chunk.
//
// `<LoginGate>` (anonymous) and `<MemberWelcomeSheet>` (a member with no name
// yet) are mutually exclusive and neither is ever fetched by the owner, so
// splitting them would buy two module preambles and nothing else. Re-exported
// from here so `<ViewerBoundary>` has a single dynamic-import specifier.
export { LoginGate } from './login-gate'
export { MemberWelcomeSheet } from './member-welcome-sheet'
