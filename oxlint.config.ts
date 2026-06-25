import config from 'eslint-plugin-devup/oxlint-config'

// retry-now is a CLI + loop engine where console output is the primary, intentional I/O
// surface, so `no-console` is turned off (the DevFive default treats it as an error for app
// code). Everything else from the DevFive oxlint config is kept as-is.
export default {
  ...config,
  rules: {
    ...config.rules,
    'no-console': 'off',
  },
}
