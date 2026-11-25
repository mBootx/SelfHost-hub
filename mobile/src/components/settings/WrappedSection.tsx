import { ChartColumn } from 'lucide-react-native'
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsKit'
import { useListeningStore } from '@/services/listeningLog'
import { durationLabel, totalSeconds, weekKey } from '@/services/wrapped'
import { useWrappedStore } from '@/store/wrappedStore'

/** Settings → Écoute: the Wrapped (by day, week, month, year or span), open at any time. */
export default function WrappedSection() {
  const open = useWrappedStore((s) => s.open)
  const thisWeek = useListeningStore((s) => Math.round(totalSeconds(s.weeks[weekKey(Date.now())]) / 60))

  return (
    <SettingsCard>
      <SettingsRow
        icon={ChartColumn}
        title="Récap d'écoute"
        meta={`${thisWeek > 0 ? `${durationLabel(thisWeek)} cette semaine` : 'Minutes, top titres et artistes'} · par jour, semaine, mois ou année`}
        onPress={open}
      />
    </SettingsCard>
  )
}
