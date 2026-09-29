import { useState } from 'react'
import { Download } from 'lucide-react-native'
import { useDowntifyStore } from '@/store/downtifyStore'
import LoginLayout, { Field } from '@/components/LoginLayout'
import { colors } from '@/constants/theme'

export default function LoginScreen() {
  const connect = useDowntifyStore((s) => s.connect)
  const [url, setUrl] = useState('http://')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(): Promise<void> {
    setError(null)
    setLoading(true)
    try {
      await connect(url, true)
    } catch (err: any) {
      setError(err?.message || 'Connexion impossible')
    } finally {
      setLoading(false)
    }
  }

  return (
    <LoginLayout
      icon={Download}
      accent={colors.downtify}
      title="Connexion à Downtify"
      subtitle="Gestionnaire de téléchargements"
      error={error}
      loading={loading}
      onSubmit={handleSubmit}
    >
      <Field
        label="URL du service"
        value={url}
        onChangeText={setUrl}
        placeholder="http://192.168.1.10:9090"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={handleSubmit}
      />
    </LoginLayout>
  )
}
