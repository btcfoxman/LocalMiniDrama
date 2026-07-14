const yaml = require('js-yaml');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigValues(base, incoming) {
  if (!isPlainObject(base) || !isPlainObject(incoming)) return incoming;
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = key in merged ? mergeConfigValues(merged[key], value) : value;
  }
  return merged;
}

/**
 * Repair duplicate top-level YAML mapping sections without discarding values from
 * earlier sections. js-yaml's `json: true` option keeps only the last duplicate,
 * which would silently lose user configuration, so each section is parsed and
 * merged independently instead.
 */
function repairDuplicateTopLevelMappings(raw) {
  const source = String(raw || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(source);
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop();

  const blocks = [];
  const topLevelKeyPattern = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s*(.*))?$/;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(topLevelKeyPattern);
    if (!match) continue;
    if (blocks.length) blocks[blocks.length - 1].end = index;
    const suffix = String(match[2] || '').trim();
    blocks.push({
      key: match[1],
      start: index,
      end: lines.length,
      isMapping: suffix === '' || suffix.startsWith('#'),
    });
  }

  const groups = new Map();
  blocks.forEach((block, blockIndex) => {
    if (!block.isMapping) return;
    const list = groups.get(block.key) || [];
    list.push({ ...block, blockIndex });
    groups.set(block.key, list);
  });

  const replacements = new Map();
  const skippedBlockIndexes = new Set();
  const repairedKeys = [];

  for (const [key, entries] of groups) {
    if (entries.length < 2) continue;
    let mergedValue = {};
    for (const entry of entries) {
      const sectionText = lines.slice(entry.start, entry.end).join('\n');
      const parsed = yaml.load(sectionText);
      if (!isPlainObject(parsed) || !isPlainObject(parsed[key])) {
        throw new Error(`Cannot safely merge duplicated YAML section: ${key}`);
      }
      mergedValue = mergeConfigValues(mergedValue, parsed[key]);
    }
    const replacement = yaml.dump(
      { [key]: mergedValue },
      { lineWidth: -1, noRefs: true }
    ).trimEnd().split('\n');
    replacements.set(entries[0].blockIndex, replacement);
    entries.slice(1).forEach((entry) => skippedBlockIndexes.add(entry.blockIndex));
    repairedKeys.push(key);
  }

  if (!repairedKeys.length) return { text: source, repairedKeys };

  const output = lines.slice(0, blocks[0]?.start || 0);
  blocks.forEach((block, blockIndex) => {
    if (skippedBlockIndexes.has(blockIndex)) return;
    const replacement = replacements.get(blockIndex);
    output.push(...(replacement || lines.slice(block.start, block.end)));
  });

  let text = output.join(newline);
  if (hadTrailingNewline) text += newline;
  // Validate the repaired document before the caller writes it to disk.
  yaml.load(text);
  return { text, repairedKeys };
}

module.exports = {
  repairDuplicateTopLevelMappings,
};
