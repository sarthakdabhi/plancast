# Security policy

## Supported versions

Security fixes target the latest Plancast release and the `main` branch. Upgrade
to the latest release before reporting an issue; older releases do not receive
separate security backports.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/sarthakdabhi/plancast/security/advisories/new)
to report suspected vulnerabilities privately. Do not include vulnerability
details or credentials in public issues.

Include the affected version, macOS version, reproduction steps using synthetic
documents, expected behavior, and potential impact. Remove API keys, private
source documents, generated transcripts, audio, and source-containing JSON
sidecars from attachments. The maintainer will review the report and coordinate
any fix and disclosure with you.

Plancast processes documents locally by default. Explicitly selected cloud
providers receive content as described in the README; fetching a public article
contacts its website. Unexpected disclosure of content or credentials, unsafe
input handling, and failures of local runtime isolation are security concerns.
