#!/usr/bin/env bash

normalize_dns() {
  node -e '
    const net = require("node:net");
    const entries = process.argv[1].trim().split(/[\s,]+/).filter(Boolean);
    if (entries.some(entry => !net.isIP(entry))) process.exit(1);
    console.log([...new Set(entries.map(entry => entry.split("%")[0]))].join(" "));
  ' "$1"
}

dns_family() {
  local entry separator=""
  for entry in $1; do
    if { [ "$2" = 6 ] && [[ "$entry" == *:* ]]; } || { [ "$2" = 4 ] && [[ "$entry" != *:* ]]; }; then
      printf '%s%s' "$separator" "$entry"
      separator=" "
    fi
  done
}

same_dns() {
  [ "$(normalize_dns "$1" | tr ' ' '\n' | sort)" = "$(normalize_dns "$2" | tr ' ' '\n' | sort)" ]
}
