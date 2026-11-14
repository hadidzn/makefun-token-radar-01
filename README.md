# Token Radar

A token launch radar: every pre-token protocol on the DefiLlama watchlist (40) plus every
rankable pre-token protocol below the $50M floor (186), ranked by an implied value computed
from the snapshot's own figures — TVL, seven-day growth, age with no token, chain reach and
fade. Model radar-2, in `lib/model.ts`. The dashboard is a static page (no network, no
framework) with a sortable, filterable board, a per-protocol detail view with the model's
breakdown and a seven-step farm plan, and a live-token view set aside.

Run it: `MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`.
