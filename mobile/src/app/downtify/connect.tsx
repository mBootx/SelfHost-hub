import { useEffect } from 'react'
import { useNavigation, useRouter } from 'expo-router'
import { useDowntifyStore } from '@/store/downtifyStore'
import LoginScreen from '@/components/downtify/LoginScreen'

/**
 * Downtify lost its own tab, so this is the only way in. It pops itself once the
 * store reports a connection, dropping the user back on Reglages.
 */
export default function DowntifyConnectScreen() {
  const navigation = useNavigation()
  const router = useRouter()
  const status = useDowntifyStore((s) => s.status)

  useEffect(() => {
    navigation.setOptions({ title: 'Downtify' })
  }, [])

  useEffect(() => {
    if (status === 'connected' && router.canGoBack()) router.back()
  }, [status])

  return <LoginScreen />
}
