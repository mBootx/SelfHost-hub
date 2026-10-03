import { useRouter } from 'expo-router'
import CarModeOverlay from '@/components/carmode/CarModeOverlay'

/** The car mode, full screen (opened from the settings or the player's menu, see components/carmode/CarModeToggle). */
export default function CarModeScreen() {
  const router = useRouter()
  return <CarModeOverlay onExit={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
}
