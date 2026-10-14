import { ChartColumn } from 'lucide-react-native'
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsKit'
import { useListeningStore } from '@/services/listeningLog'
import { durationLabel, totalSeconds, weekKey } from '@/services/wrapped'
import { useWrappedStore } from '@/store/wrappedStore'

/** Settings → Écoute: the weekly Wrapped, open at any time. */
export default function WrappedSection() {
  const open = useWrappedStore((s) => s.open)
  const thisWeek = useListeningStore((s) => Math.round(totalSeconds(s.weeks[weekKey(Date.now())]) / 60))

  return (
    <SettingsCard>
      <SettingsRow
        icon={ChartColumn}
        title="Récap de la semaine"
        meta={`${thisWeek > 0 ? `${durationLabel(thisWeek)} cette semaine` : 'Top titres, minutes et artistes'} · tous les lundis à 10 h`}
        onPress={open}
      />
    </SettingsCard>
  )
}
