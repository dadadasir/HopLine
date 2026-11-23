# Security policy

## Supported versions

| Version | Security support |
| --- | --- |
| 0.4.0 and current `main` | Reports accepted. Fixes land on `main`. |

## Report a vulnerability privately

Use this repository's **Security › Report a vulnerability**, or open [GitHub's private vulnerability reporting form](https://github.com/dadadasir/HopLine/security/advisories/new). Do not put vulnerability details in a public issue or pull request. GitHub private vulnerability reporting is the disclosure channel for this project.

Include the affected version or build, operating system, reproduction steps, expected and observed behavior, and likely impact. Use a minimal reproduction with fictional host details. Never include live passwords, private keys, access tokens, or unreviewed diagnostic output.

Maintainers follow up through the private report and coordinate disclosure after a fix or mitigation is available.

## Areas of particular interest

- SSH host-key verification, fingerprint changes, credential storage, master-password handling, and encrypted backups.
- Malicious remote output that triggers local actions, including clipboard writes, link opening, commands, or network requests.
- Injection or unsafe execution in runbooks, initialization steps, and remediation commands, including bypasses of safety gates that prevent SSH lockout.
- Incomplete redaction of host details, credentials, or other sensitive content in diagnostic exports.

Test only systems you own or are authorized to assess. Keep exploit details and any sensitive evidence inside the private report until disclosure is coordinated.
