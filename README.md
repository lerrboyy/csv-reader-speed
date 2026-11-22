# csv-reader-speed

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/lerrboyy/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/lerrboyy/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0, written for the make.fun bounty
[csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
("Read broken CSV files faster, 21 November 2026"). `run(input)` returns exactly
csv-reader's answer — `{columns, rows, errors}` — for every `{text, header}` input,
including its handling of broken CSV: BOM, LF/CRLF records, stray CRs, quoted fields
with `""` escapes and CR/LF normalisation, junk after a closing quote, unterminated
quotes re-read as unquoted, and short/long row padding and cutting.

`solve.js` is a dependency-free ES module exporting `run`. `main.ts` is the harness
driver: it turns V8 incremental marking off, reads the cases from
`MAKEFUN_INPUT_DIR` (or `/input`), answers each one alone with `run`, and writes
the answers to `MAKEFUN_OUTPUT_DIR` (or `/output`).

## Differential test

Compare this parser against the kit's reference on the 87-case adversarial suite:

```sh
node /tmp/csvprobe/difftest.mjs /home/hatch/workspace/makefun/csv-reader-speed/solve.js /tmp/csvprobe/adversarial.json
```

All 87 cases must print PASS.
