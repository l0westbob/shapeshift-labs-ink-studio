#!/bin/bash
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../_fixtures/setup.sh" gate.json:worlds/gate.json
