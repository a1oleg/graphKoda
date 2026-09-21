export function providerMosaicParts(parts) {
  return parts.map((part, index) => {
    const receiver = parts[index - 1];
    const provider = receiver?.kind === 'value'
      && receiver.labels?.some(label => label === 'SystemProvider' || label === 'OperationProvider');
    if (!provider || part.kind !== 'method' || part.labels?.includes('Virtual')
      || !/^[$\p{ID_Start}][\p{ID_Continue}$]*\(\)?$/u.test(part.text || '')) return part;
    return { ...part, text: `.${part.text}`, ...(part.plainText ? { plainText: `.${part.plainText}` } : {}) };
  });
}
