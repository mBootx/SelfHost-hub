import { useState } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import ReconnectPanel from '@/components/ReconnectPanel'
import LoginScreen from './LoginScreen'
import { colors } from '@/constants/theme'

export default function NavidromeGate({ children }: { children: React.ReactNode }) {
  const status = useNavidromeStore((s) => s.status)
  const error = useNavidromeStore((s) => s.error)
  const savedSession = useNavidromeStore((s) => s.savedSession)
  const restoreSession = useNavidromeStore((s) => s.restoreSession)
  const downloaded = useOfflineStore((s) => Object.keys(s.tracks).length)
  const [switching, setSwitching] = useState(false)

  if (status === 'connected') return <>{children}</>
  // Connecting, or the app has just started and hasn't looked for a saved login yet: no login form flashes by.
  if (status === 'connecting' || (status === 'disconnected' && savedSession === null)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.base }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }
  if (status === 'error' && savedSession && !switching) {
    return (
      <ReconnectPanel
        service="Navidrome"
        error={error}
        onRetry={restoreSession}
        onSwitch={() => setSwitching(true)}
        hint={downloaded > 0 ? "Les titres téléchargés de la file d'attente se lisent toujours." : undefined}
      />
    )
  }
  return <LoginScreen />
}
