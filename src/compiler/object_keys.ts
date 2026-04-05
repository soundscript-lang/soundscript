function sanitizeObjectKeysHelperNamePart(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

function createStableHelperIdentityHash(identity: string): string {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createObjectKeysHelperIdentity(
  representationName: string,
  propertyKeys: readonly string[],
): string {
  return `${representationName}\u0000${propertyKeys.join('\u0000')}`;
}

export function createSpecializedObjectKeysHelperName(
  representationName: string,
  propertyKeys: readonly string[],
): string {
  return [
    'list_specialized_object_keys',
    sanitizeObjectKeysHelperNamePart(representationName),
    createStableHelperIdentityHash(createObjectKeysHelperIdentity(representationName, propertyKeys)),
  ].join('__');
}

export function getFallbackObjectKeysHelperName(): string {
  return 'list_fallback_object_keys_in_js_own_property_order';
}
