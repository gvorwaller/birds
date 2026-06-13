/**
 * Symmetric encryption-at-rest for stored eBird credentials (API key + account
 * login). AES-256-GCM keyed from EBIRD_KEY_SECRET in .env. Output format:
 * base64url(iv) . base64url(tag) . base64url(ciphertext)
 *
 * Never log plaintext or ciphertext values (cs.md eBird SACRED RULES).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

function key(): Buffer {
	const secret = env.EBIRD_KEY_SECRET;
	if (!secret) {
		throw new Error('EBIRD_KEY_SECRET is not set — cannot encrypt/decrypt eBird credentials');
	}
	return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(stored: string): string {
	const [ivB64, tagB64, ctB64] = stored.split('.');
	if (!ivB64 || !tagB64 || !ctB64) {
		throw new Error('Stored credential has unexpected format');
	}
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
	return Buffer.concat([
		decipher.update(Buffer.from(ctB64, 'base64url')),
		decipher.final()
	]).toString('utf8');
}
