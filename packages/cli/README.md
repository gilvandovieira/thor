# @gilvandovieira/cli

The deliberately narrow Thor CLI. This release provides `thor init`,
`thor create <name>`, and `thor capabilities <postgres|sqlite|mysql>`. The
capabilities command prints every `native`, `emulated`, `unsupported`, or
`unknown` status from Thor's authoritative dialect matrices without connecting
to a database. Database-connected migration commands remain available through
the programmatic `@gilvandovieira/thor/migrate` API.

Node.js 22 or newer is supported. Run `thor --help` for the shipped command set.
