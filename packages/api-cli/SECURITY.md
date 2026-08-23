# Security

Do not report a vulnerability in a public issue. Use GitHub private vulnerability reporting for `rivetplane/cli`.

Do not pass a token with `--token` on a shared system because another process can read the command line. Use `--token-stdin`, `RIVETPLANE_TOKEN`, or the hidden login prompt.

The CLI does not print saved tokens. It stores credentials with owner-only permissions where the operating system supports them.
