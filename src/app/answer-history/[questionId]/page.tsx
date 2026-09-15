import { AnswerHistory } from '@/components/answer-audio/AnswerHistory';
export const dynamic = 'force-dynamic';
export default async function AnswerHistoryPage({ params }: { params: Promise<{ questionId: string }> }) { return <AnswerHistory questionId={(await params).questionId} />; }
