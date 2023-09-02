;; domain file: domain-lights.pddl
(define (domain default)
    (:requirements :strips)
    (:predicates
        (tile ?t)
        (occupied ?tile)
        (delivery ?t)
        (agent ?a)
        (me ?a)
        (at ?agentOrParcel ?tile)
        (right ?t1 ?t2)
        (down ?t1 ?t2)
    )
    
    (:action right
        :parameters (?me ?from ?to)
        :precondition (and
            (me ?me)
            (at ?me ?from)
            (right ?to ?from)
            (not (occupied ?to))
        )
        :effect (and
            (at ?me ?to)
			(not (at ?me ?from))
        )
    )
    (:action left
        :parameters (?me ?from ?to)
        :precondition (and
            (me ?me)
            (at ?me ?from)
            (right ?from ?to)
            (not (occupied ?to))
        )
        :effect (and
            (at ?me ?to)
			(not (at ?me ?from))
        )
    )
    (:action up
        :parameters (?me ?from ?to)
        :precondition (and
            (me ?me)
            (at ?me ?from)
            (down ?from ?to)
            (not (occupied ?to))
        )
        :effect (and
            (at ?me ?to)
			(not (at ?me ?from))
        )
    )
    (:action down
        :parameters (?me ?from ?to)
        :precondition (and
            (me ?me)
            (at ?me ?from)
            (down ?to ?from)
            (not (occupied ?to))
        )
        :effect (and
            (at ?me ?to)
			(not (at ?me ?from))
        )
    )
)