import 'expo-router/entry'

// Background tasks must be defined as soon as the bundle loads: Android can start the app without any
// screen to run one, and then the router never loads the screens that would otherwise import them.
import './src/services/cameraBackup'
