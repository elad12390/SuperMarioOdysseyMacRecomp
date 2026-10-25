import { expect, test } from 'bun:test';
import { inspectNsp, classifyInputs, validateKeyFile } from '../web/intake';
test('damaged NSP is rejected before conversion', async () => {
 await expect(inspectNsp(new File([new Uint8Array(32)], 'game.nsp'))).rejects.toThrow('PFS0');
});
test('oversized PFS metadata cannot cause unbounded allocation', async () => {
 const header = new Uint8Array(16); header.set(new TextEncoder().encode('PFS0')); new DataView(header.buffer).setUint32(4, 0xffffffff, true);
 await expect(inspectNsp(new File([header], 'game.nsp'))).rejects.toThrow('metadata');
});
test('intake classifies supplied files and rejects duplicates', () => {
 expect(classifyInputs([new File([''], 'base.nsp'),new File([''], 'prod.keys')]).prodKeys?.name).toBe('prod.keys');
 expect(()=>classifyInputs([new File([''], 'one.nsp'),new File([''], 'two.nsp')])).toThrow('one');
});
test('wrong key content is actionable and never reflected', async () => {
 const privateText='some secret user value';
 try { await validateKeyFile(new File([privateText], 'prod.keys')); throw new Error('accepted'); } catch(error) { expect(String(error)).toContain('key'); expect(String(error)).not.toContain(privateText); }
});
