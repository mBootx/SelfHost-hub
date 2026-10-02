const fake = require('./fake')
exports.AuthenticationType = { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 }
exports.SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 }
exports.supportedAuthenticationTypesAsync = async () => fake.fingerprint.types
exports.getEnrolledLevelAsync = async () => fake.fingerprint.level
exports.authenticateAsync = async (opts) => { fake.lastAuthOptions = opts; return fake.fingerprint.succeed ? { success: true } : { success: false, error: 'user_cancel' } }
