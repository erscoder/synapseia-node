/**
 * Workstream F shared byte-contract vector for the coord-signed
 * peer-identity-attestation domain. The SAME expected hex MUST be asserted on
 * the COORDINATOR side (F1) — if either side's signed-bytes format drifts,
 * exactly one of the two specs fails.
 *
 * Mirrors the existing shared-vector discipline for the other three domains
 * (see `verify-coordinator-envelope.spec.ts ::
 * "reconstructs the canonical shared-vector signed bytes"`).
 *
 * Fixed input (do NOT change — it is the cross-package contract):
 *   domain = synapseia/gossip/peer-identity-attestation/v1
 *   body   = { p2pPeerId, appPubkey, verified }  (keys in THIS order)
 *   ts     = 1717000000  (unix-seconds)
 */
import { DOMAIN_PEER_IDENTITY_ATTESTATION } from '../verify-coordinator-envelope';

describe('peer-identity-attestation shared byte-contract vector', () => {
  it('reconstructs the canonical shared-vector signed bytes (hex byte-contract)', () => {
    const domain = DOMAIN_PEER_IDENTITY_ATTESTATION;
    const body = {
      p2pPeerId: '12D3KooWPeerIdentityAttestationTestVector000000000000',
      appPubkey: '0101010101010101010101010101010101010101010101010101010101010101',
      verified: true,
    };
    const ts = 1_717_000_000;

    // Byte-identical reconstruction to the coord `signedEnvelopeBytes`
    // (`TextEncoder().encode(JSON.stringify({ domain, body, ts }))`) — NO
    // key-sort (the wrapper + body are fixed-shape literals).
    const signedBytes = new TextEncoder().encode(
      JSON.stringify({ domain, body, ts }),
    );
    const hex = Buffer.from(signedBytes).toString('hex');

    expect(hex).toBe(
      '7b22646f6d61696e223a2273796e6170736569612f676f737369702f706565722d6964656e746974792d6174746573746174696f6e2f7631222c22626f6479223a7b22703270506565724964223a22313244334b6f6f57506565724964656e746974794174746573746174696f6e54657374566563746f72303030303030303030303030222c226170705075626b6579223a2230313031303130313031303130313031303130313031303130313031303130313031303130313031303130313031303130313031303130313031303130313031222c227665726966696564223a747275657d2c227473223a313731373030303030307d',
    );
  });

  it('pins the domain tag string (byte-identical to the coord constant)', () => {
    expect(DOMAIN_PEER_IDENTITY_ATTESTATION).toBe(
      'synapseia/gossip/peer-identity-attestation/v1',
    );
  });
});
