#!/bin/sh
# Prints the routes the Lab API documents, one request line each.
API=http://api.lab.localhost:4420
curl -s "$API/openapi.json" | jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[] | "\(.key | ascii_upcase) \($p)"'
