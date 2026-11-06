// Prints a new Ed25519 signing key as JWK JSON. Store it as SIGNING_KEY_JWK in your secret manager.
import { generateKeyPair, exportJWK } from 'jose';
const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
console.log(JSON.stringify(await exportJWK(privateKey)));
