// Loaded as electron-builder.yml's parent before packaging starts. Do not place
// certificate/password values in the returned config (builder writes it to disk).
const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
const alternatives = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE']
const present = (env, key) => typeof env[key] === 'string' && env[key].trim() !== ''

function signingConfig(env) {
  if (alternatives.some(key => present(env, key))) {
    throw new Error('本项目使用 Apple ID 公证：请移除 APPLE_API_KEY / APPLE_KEYCHAIN 系列变量。 / This project uses Apple ID notarization; remove API-key/keychain-profile variables.')
  }
  if (!required.some(key => present(env, key))) {
    return { mac: { identity: '-', hardenedRuntime: false, gatekeeperAssess: false, notarize: false } }
  }
  const missing = required.filter(key => !present(env, key))
  if (missing.length) {
    throw new Error(`签名与公证凭据不完整，缺少：${missing.join(', ')}。 / Incomplete signing and notarization credentials; missing: ${missing.join(', ')}.`)
  }
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) {
    throw new Error('APPLE_TEAM_ID 须为 10 位大写字母或数字。 / APPLE_TEAM_ID must contain 10 uppercase letters or digits.')
  }
  return {
    forceCodeSigning: true,
    mac: {
      // Select the Developer ID Application certificate for this team, including
      // when ambient keychain auto-discovery is disabled. The .p12 comes from CSC_LINK.
      identity: env.APPLE_TEAM_ID,
      type: 'distribution',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      notarize: true
    }
  }
}

module.exports = () => signingConfig(process.env)
module.exports.signingConfig = signingConfig
