# Guardian batches

Files here are written by `contracts/script/GuardianBatch.s.sol`. Each one is a Safe Transaction
Builder batch that a multisig guardian signs to register templates on the factory. They hold
calldata only, never keys. See [docs/DEPLOY.md](../../docs/DEPLOY.md#3-the-guardian-registers-the-templates).
