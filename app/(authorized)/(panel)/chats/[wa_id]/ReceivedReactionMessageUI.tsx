import { ReactionMessage } from "@/types/Message";

export default function ReceivedReactionMessageUI(props: { message: ReactionMessage }) {
    const { message } = props
    return (
        <>
            {message.reaction.emoji}
        </>
    )
}