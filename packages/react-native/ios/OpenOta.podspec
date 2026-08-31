require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'OpenOta'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Open OTA'
  s.homepage       = 'https://github.com/open-ota/open-ota'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.swift_version  = '5.7'
  s.source         = { git: 'https://github.com/open-ota/open-ota.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # RCTTriggerReloadCommandListeners / RCTReloadCommandSetBundleURL
  s.dependency 'React-Core'

  s.source_files = '*.{h,m,swift}'
  s.exclude_files = 'Tests/**/*'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
