import { useNavidromeStore } from '@renderer/store/navidromeStore'
import LoginPage from './LoginPage'
import MainPlayer from './MainPlayer'

export default function NavidromeModule(): JSX.Element {
  const status = useNavidromeStore((s) => s.status)

  if (status === 'connected') return <MainPlayer />

  if (status === 'connecting') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">Reconnexion en cours...</div>
    )
  }

  return <LoginPage />
}
