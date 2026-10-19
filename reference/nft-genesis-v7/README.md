# Bioentropy Genesis Collection — v7

Contrato ERC-721 de 100 NFTs de arte generativo que implementa el **Perfil NFT del Anchor
Protocol v0.2** (sección 11 de la especificación). Cada token necesita dos firmas P-256:

1. **Shield** (TROPIC01 del nodo de adquisición) sobre un `WindowRecord`: la ventana de 20 min.
2. **CiWi** (su TROPIC01) sobre un `NftClaim` = hash del registro + hash del JSON final. La firma
   solo después de verificar la firma del shield, mostrar el registro en pantalla y recibir el botón.

El shield firma al terminar cada ventana (los datos); la CiWi firma después, cuando el arte y el
JSON ya existen (la metadata).

La transacción la envía la dirección de la CiWi (firma secp256k1 hecha por su STM32).

## Cambios frente a v6

| v6 | v7 |
| --- | --- |
| Solo firma del shield | Firma del shield **y** del TROPIC01 de la CiWi (`NftClaim`) |
| `metadataHash` firmado por el shield | Lo firma la CiWi: el JSON no existe al cierre de la ventana |
| Sin respuesta óptica | `responseHash` en el registro y en el evento `Anchored` |
| Sin versión ni curva | `version = 2` y `curve = 1` (P-256) obligatorios; `curve = 2` reservado para secp256k1 |
| Dominio EIP-712 "Bioentropy Genesis", "1" | Dominio del protocolo: "WALCORG Anchor", "0.2" |
| `digestOf` | `recordDigest(rec)` (shield) y `claimDigest(rec, metadataHash)` (CiWi) |
| `mintAnchored(rec, r, s)` | `mintAnchored(rec, {metadataHash, shieldSig, ciwiSig})` |

## Qué verifica el contrato

En este orden: versión y curva, tope de 100, id secuencial, ventana válida y sin traslape,
bloque de reto pasado, firma del shield, firma de la CiWi y que lo envíe el owner.
Ambas firmas deben tener **s bajo** (s ≤ n/2).

## Qué se verifica fuera de cadena

- `challenge == blockhash(challengeBlock)` en un explorador o nodo de archivo.
- `responseHash`, `dataRoot` y `metadataHash` contra los archivos publicados en IPFS/Arweave.
- Que la imagen se regenera de forma determinista desde el dataset.

## Uso

```bash
npm install
npx hardhat test                  # 15 pruebas
LOCAL_SOLC=1 npx hardhat test     # sin acceso a binaries.soliditylang.org

BASE_URI=ipfs://<CID>/ SHIELD_PUB_X=0x.. SHIELD_PUB_Y=0x.. CIWI_PUB_X=0x.. CIWI_PUB_Y=0x.. \
FW_HASH=0x.. OWNER=<direccion CiWi> DEPLOYER_KEY=0x.. \
npx hardhat run scripts/deploy.js --network amoy
```

Orden: adquirir las 100 ventanas → generar arte y JSON → subir a IPFS → desplegar →
mintear en 4 lotes de 25 (`mintAnchoredBatch`, ~4.8 M gas por lote en pruebas locales) → OpenSea.

Pendientes para la implementación: ver la sección 12 de [SPEC.md](../../SPEC.md).
