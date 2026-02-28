export function demoteHeadingsByOneLevel(rootNode) {
  if (!rootNode || typeof rootNode.querySelectorAll !== 'function') {
    return;
  }

  const headings = [...rootNode.querySelectorAll('h1,h2,h3,h4,h5')];
  headings.forEach((heading) => {
    const matched = String(heading?.tagName || '').match(/^H([1-5])$/i);
    if (!matched?.[1]) {
      return;
    }

    const currentLevel = Number(matched[1]);
    if (!Number.isFinite(currentLevel) || currentLevel < 1 || currentLevel >= 6) {
      return;
    }

    const doc = heading.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') {
      return;
    }

    const replacement = doc.createElement(`h${currentLevel + 1}`);
    [...heading.attributes].forEach((attribute) => {
      replacement.setAttribute(attribute.name, attribute.value);
    });

    while (heading.firstChild) {
      replacement.appendChild(heading.firstChild);
    }

    heading.replaceWith(replacement);
  });
}
