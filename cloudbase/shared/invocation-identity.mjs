/** Read only the identity supplied with this SCF invocation. */
export function readInvocationIdentity(context, parseContext) {
  try {
    if (!context || typeof context !== 'object' || Array.isArray(context) || typeof parseContext !== 'function') return null;
    const ownData = (object, name) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor : null;
    };
    const environment = ownData(context, 'environment');
    const environ = ownData(context, 'environ');
    // An invalid modern field must not fall back to the legacy field.
    const modern = Object.hasOwn(context, 'environment');
    if (modern) {
      if (!environment || typeof environment.value !== 'string' || !environment.value.trim()) return null;
    } else if (!environ || typeof environ.value !== 'string' || !environ.value.trim()) return null;
    // The SDK destructures properties, including inherited values and accessors.
    // Pass only the validated own data field from this invocation.
    const snapshot = modern ? { environment: environment.value } : { environ: environ.value };
    const parsed = parseContext(snapshot);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Object.hasOwn(parsed, modern ? 'environment' : 'environ') || Object.hasOwn(parsed, modern ? 'environ' : 'environment')) return null;
    const values = ownData(parsed, modern ? 'environment' : 'environ')?.value;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const uid = ownData(values, 'TCB_UUID')?.value;
    const anonymous = ownData(values, 'TCB_ISANONYMOUS_USER')?.value;
    if (typeof uid !== 'string' || !uid || uid !== uid.trim() || uid.length > 256 || /[\u0000-\u001f\u007f]/.test(uid)) return null;
    if (anonymous !== false && anonymous !== 'false') return null;
    return { uid, isAnonymous: false };
  } catch { return null; }
}
