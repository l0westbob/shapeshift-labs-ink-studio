const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const frontmatter = file => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(file, 'utf8'));
  assert.ok(match, 'frontmatter in ' + file);
  return Object.fromEntries(match[1].split('\n').map(line => /^([a-z-]+):\s*(.*)$/.exec(line)).filter(Boolean).map(m => [m[1], m[2]]));
};
const plugin = file => path.join(root, file.replace('${CLAUDE_PLUGIN_ROOT}/', ''));

test('the plugin manifest, marketplace and components point at real files', () => {
  const manifest = read('.claude-plugin/plugin.json');
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(market.plugins[0].name, manifest.name);
  assert.equal(market.plugins[0].source, './');
  assert.equal(manifest.version, read('package.json').version);

  const server = manifest.mcpServers['ink-studio'];
  assert.ok(fs.existsSync(plugin(server.args[0])), 'MCP server script exists');

  const skills = path.join(root, manifest.skills);
  const names = fs.readdirSync(skills);
  assert.deepEqual(names.sort(), ['best-of-n', 'look-tuning', 'new-scene', 'review', 'scene-authoring', 'world-sim']);
  for (const name of names) {
    const meta = frontmatter(path.join(skills, name, 'SKILL.md'));
    assert.equal(meta.name, name);
    assert.ok(meta.description.length > 40, name + ' has a useful description');
  }
  for (const agent of manifest.agents) {
    const meta = frontmatter(path.join(root, agent));
    assert.ok(meta.name && meta.description);
  }
  const hooks = read(manifest.hooks).hooks.PostToolUse[0].hooks[0].command;
  assert.ok(fs.existsSync(plugin(/"([^"]+)"/.exec(hooks)[1])), 'hook script exists');
});

test('skills only name tools the server provides', () => {
  require('../agent/ops/index.js');
  const tools = new Set(require('../agent/registry.js').list().map(op => op.name));
  const dir = path.join(root, 'plugin');
  const files = [
    ...fs.readdirSync(path.join(dir, 'skills')).map(name => path.join(dir, 'skills', name, 'SKILL.md')),
    ...fs.readdirSync(path.join(dir, 'agents')).map(name => path.join(dir, 'agents', name))
  ];
  for (const file of files)
    for (const [name] of fs.readFileSync(file, 'utf8').matchAll(/\b(?:scene|world|ink)_[a-z_]+\b/g))
      assert.ok(tools.has(name), name + ' in ' + path.relative(root, file) + ' is a real tool');
  const director = fs.readFileSync(path.join(dir, 'agents', 'ink-art-director.md'), 'utf8');
  const granted = [...director.matchAll(/mcp__plugin_ink-studio_ink-studio__([a-z_]+)/g)].map(m => m[1]);
  assert.ok(granted.length >= 4);
  for (const name of granted) assert.ok(tools.has(name), name);
  for (const name of granted) assert.ok(!['scene_edit', 'scene_save', 'ink_cli', 'look'].includes(name), 'the critic only gets read tools');
});

test('the write hook validates dioramas and worlds and ignores everything else', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hook = (file, extra = {}) => spawnSync(process.execPath, [path.join(root, 'agent', 'hooks', 'validate-on-write.js')], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file }, cwd: root, ...extra }), encoding: 'utf8'
  });
  assert.equal(hook('examples/scene.json').status, 0);
  assert.equal(hook('package.json').status, 0);
  assert.equal(hook('README.md').status, 0);
  assert.equal(hook('examples/world-puzzle-gate.json').status, 0);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ id: 'bad', solids: [{ kind: 'bal', at: [0, 1, 0], r: 1, mat: 'accent' }] }));
  const rejected = hook(bad);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /did you mean "ball"/);

  const world = path.join(dir, 'world.json');
  fs.writeFileSync(world, JSON.stringify({ format: 'ink-studio/world', version: 1, id: 'x', dt: 'a' }));
  assert.equal(hook(world).status, 2);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{"id": "x", "solids": [{"kind": "ball",');
  assert.match(hook(broken).stderr, /not valid JSON/);
  const unrelated = path.join(dir, 'other.json');
  fs.writeFileSync(unrelated, '{"name": ');
  assert.equal(hook(unrelated).status, 0, 'broken JSON that is not ours is ignored');
  const foreign = path.join(dir, 'level.json');
  fs.writeFileSync(foreign, JSON.stringify({ layers: [], solids: [{ name: 'wall', points: [] }] }));
  assert.equal(hook(foreign).status, 0, 'other formats with a solids array are ignored');
});
