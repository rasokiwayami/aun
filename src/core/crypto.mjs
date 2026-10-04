import {randomBytes, createCipheriv, createDecipheriv, scrypt as derive} from 'node:crypto';
import {promisify} from 'node:util';
import {requireThat, fail} from './errors.mjs';
const scrypt = promisify(derive);
const b64 = value => Buffer.from(value).toString('base64');
const decode = (value, max) => {
  requireThat(typeof value === 'string' && value.length <= max && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'cipher_invalid');
  return Buffer.from(value, 'base64');
};
export function seal(key, bytes, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {authTagLength:16});
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {iv:b64(iv), tag:b64(cipher.getAuthTag()), data:b64(data)};
}
export function unseal(key, envelope, aad, maxBytes = 48*1024*1024) {
  requireThat(envelope && typeof envelope === 'object', 'cipher_invalid');
  const iv = decode(envelope.iv,24), tag = decode(envelope.tag,32), data = decode(envelope.data,Math.ceil(maxBytes*4/3)+4);
  requireThat(iv.length===12 && tag.length===16 && data.length<=maxBytes,'cipher_invalid');
  const decipher = createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data),decipher.final()]);
}
export async function deriveKey(passphrase, salt) {
  requireThat(typeof passphrase === 'string' && passphrase.length>=10 && passphrase.length<=1024,'passphrase_invalid');
  requireThat(Buffer.isBuffer(salt) && salt.length===16,'cipher_invalid');
  return scrypt(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
}
export async function wrapKey(key, passphrase, aad) {
  const salt=randomBytes(16), derived=await deriveKey(passphrase,salt);
  try {return {kdf:'scrypt-n32768-r8-p1',salt:b64(salt),wrapped:seal(derived,key,aad)}} finally {derived.fill(0)}
}
export async function unwrapKey(envelope,passphrase,aad) {
  requireThat(envelope?.kdf==='scrypt-n32768-r8-p1','cipher_invalid');
  const derived=await deriveKey(passphrase,decode(envelope.salt,24));
  try {const key=unseal(derived,envelope.wrapped,aad,32);requireThat(key.length===32,'cipher_invalid');return key} finally {derived.fill(0)}
}
export async function encryptBackup(state, passphrase) {
  const key=randomBytes(32),format='hitotsuzutsu.encrypted-backup/1';
  try {return JSON.stringify({format,key:await wrapKey(key,passphrase,format),payload:seal(key,Buffer.from(JSON.stringify(state)),format)})}finally{key.fill(0)}
}
export async function decryptBackup(text,passphrase) {
  let key;
  try {requireThat(typeof text==='string'&&text.length<=64*1024*1024);const x=JSON.parse(text);requireThat(x.format==='hitotsuzutsu.encrypted-backup/1');key=await unwrapKey(x.key,passphrase,x.format);return JSON.parse(unseal(key,x.payload,x.format).toString('utf8'))}catch{fail('backup_invalid',422)}finally{key?.fill(0)}
}
