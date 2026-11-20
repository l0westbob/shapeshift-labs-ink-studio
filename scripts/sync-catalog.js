// node scripts/sync-catalog.js [--check] : keep catalog.json in step with the agent tools and the CLI's commands.
/* Hand-written entries are left alone. Generated entries (generated: true) are rebuilt from two sources:
     every op in the agent registry becomes an "agent" entry (id agent.<name>), and
     every CLI command listed by `ink-studio help` that no hand-written entry mentions becomes a "cli" entry (id cli.<name>).
   --check exits 1 without writing when the catalog is out of date. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const file = path.join(root, 'catalog.json');

function helpCommands() {
  const help = spawnSync(process.execPath, [path.join(root, 'cli', 'ink-studio.js'), 'help'], { cwd: root, encoding: 'utf8' });
  if (help.status !== 0) throw new Error('ink-studio help failed: ' + help.stderr);
  const commands = new Map();
  for (const line of help.stdout.split('\n')) {
    const match = /^  ([a-z][a-z0-9-]*)\b(.*)$/.exec(line);
    if (!match || commands.has(match[1])) continue;
    const [usage, description] = (match[1] + match[2]).split(/\s{3,}/);
    commands.set(match[1], { usage: usage.trim(), description: (description ?? '').trim() });
  }
  return commands;
}

function build(catalog) {
  const manual = catalog.entries.filter(entry => !entry.generated);
  const mentioned = new Set();
  for (const entry of manual)
    for (const match of String(entry.use ?? '').matchAll(/ink-studio ([a-z][a-z0-9-]*)/g)) mentioned.add(match[1]);

  require(path.join(root, 'agent', 'ops', 'index.js'));
  const tools = require(path.join(root, 'agent', 'registry.js')).list().map(op => ({
    id: 'agent.' + op.name,
    kind: 'agent',
    status: 'ready',
    title: op.title,
    what: op.description.split(/(?<=\.)\s/)[0],
    use: 'MCP tool ' + op.name + ' or: ink-studio agent call ' + op.name + " '<json>'",
    where: 'agent/ops',
    tags: ['agent', 'mcp', op.effects],
    generated: true
  }));
  const commands = [...helpCommands()]
    .filter(([name]) => !mentioned.has(name) && name !== 'agent')
    .map(([name, { usage, description }]) => ({
      id: 'cli.' + name,
      kind: 'cli',
      status: 'ready',
      title: description ? description[0].toUpperCase() + description.slice(1) : 'ink-studio ' + name,
      what: description || 'See ink-studio help.',
      use: 'ink-studio ' + usage,
      where: 'cli/ink-studio.js',
      tags: ['cli', 'agent: ink_cli'],
      generated: true
    }));
  return { ...catalog, entries: [...manual, ...tools, ...commands] };
}

if (require.main === module) {
  const current = fs.readFileSync(file, 'utf8');
  const next = JSON.stringify(build(JSON.parse(current)), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('catalog.json is out of date: run node scripts/sync-catalog.js');
      process.exit(1);
    }
    console.log('catalog in sync');
  } else {
    fs.writeFileSync(file, next);
    console.log('catalog.json updated');
  }
}

module.exports = { build, helpCommands };
