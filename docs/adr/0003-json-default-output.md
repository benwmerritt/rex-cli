# JSON by default, with stable exit codes

`rex` is agent-first, so stdout is JSON by default (lists as
`{nodes, pageInfo}`); `--human` is opt-in for people. Errors go to stderr as
`{error:{code,message,details}}` with a fixed exit-code taxonomy (2 usage, 3
auth, 4 ratelimit, 5 notfound, 6 validation, 7 api, 8 write-gated). This is the
opposite default from the Linear CLI (human-first, `--json` opt-in), chosen
because the primary consumer here is an agent that must never accidentally parse
an ANSI table.
