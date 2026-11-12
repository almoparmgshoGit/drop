/**
 * The declared type comes from the client, so the stored type is decided by the file's own bytes.
 * No SVG: a stored image is served back as-is and must never be able to run script.
 */
export const imageTypeOf = (file: Buffer) => {
  if (file.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (file.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (file.subarray(0, 4).toString('latin1') === 'RIFF' && file.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
};
