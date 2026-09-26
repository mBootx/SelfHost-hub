import { View, ActivityIndicator } from 'react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import LoginScreen from './LoginScreen'
import { colors } from '@/constants/theme'

export default function NavidromeGate({ children }: { children: React.ReactNode }) {
  const status = useNavidromeStore((s) => s.status)
  if (status === 'connected') return <>{children}</>
  if (status === 'connecting') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.base }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }
  return <LoginScreen />
}
