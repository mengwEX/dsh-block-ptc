# Security

Security fixes target the latest released version. `package.json` declares
minimum host versions without upper bounds. Those ranges permit installation;
they do not imply every newer runtime has passed compatibility checks. See the
README for verification history and current limits.

Report suspected vulnerabilities privately to **mengw.ex@gmail.com**, with
`dsh-block-ptc security` in the subject. Include affected versions and a minimal
reproduction, with secrets removed. Please avoid posting exploitable details in
a public issue before a fix is available.

Programs run through the host's built-in `run_code` transport. Permissions,
sandbox enforcement and tool access are controlled by DSH. A block is a context
grouping mechanism, not a security boundary. Summarizing a block changes the
model-visible context; original messages remain in the session log and should
still be treated as sensitive data.
