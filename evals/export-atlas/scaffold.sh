#!/bin/bash
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../_fixtures/setup.sh" gem.json:scenes/gem.json
