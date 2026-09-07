const major = Number(process.versions.node.split('.')[0]);
if (major !== 24 && major !== 26) {
  throw new Error(`Release verification requires Node 24 or 26; found ${process.versions.node}.`);
}
